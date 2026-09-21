import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/types";
import { row, run } from "../db/index.js";
import { RP_NAME, RP_ID, ORIGIN, CHALLENGE_TTL_SECONDS } from "../config.js";
import { audit } from "../services/audit.js";
import { advanceAfterRegistration, expectedDeviceForStatus, getUser, getUserByEmail, reactivateViaRecovery } from "../services/ceremonyApi.js";

export const registerRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Step 0 (not in the PDF ceremony diagram, but required to have a user_id
 * to bind challenges to). The internal `userId` (a UUID) is returned only
 * for the client to hold in memory for the rest of THIS enrolment session
 * — it is never something the user is asked to remember. Email is the
 * human-facing identifier, used later for account recovery.
 */
registerRouter.post("/start-account", (req, res) => {
  const displayName = String(req.body?.displayName ?? "").trim();
  const email = String(req.body?.email ?? "").trim().toLowerCase();

  if (!displayName) return res.status(400).json({ error: "displayName is required" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "a valid email is required" });
  if (getUserByEmail(email)) {
    return res.status(409).json({ error: "an account with this email already exists" });
  }

  const userId = randomUUID();
  run(
    "INSERT INTO users (id, display_name, email, status) VALUES (?, ?, ?, 'PENDING_LAPTOP')",
    [userId, displayName, email]
  );
  audit(userId, "account.created", { displayName, email });
  res.status(201).json({ userId, email, status: "PENDING_LAPTOP" });
});

/** readme.md §6.1 step 2 — one call per authenticator (laptop, then phone, then security key). */
registerRouter.post("/begin", async (req, res) => {
  const userId = String(req.body?.userId ?? "");
  const user = getUser(userId);
  if (!user) return res.status(404).json({ error: "unknown user" });

  const deviceLabel = expectedDeviceForStatus(user.status);
  if (!deviceLabel) {
    return res.status(409).json({ error: "no registration expected in current account state", status: user.status });
  }

  const existingCreds = row<{ ids: string }>(
    "SELECT group_concat(cred_id) as ids FROM credentials WHERE user_id = ?",
    [userId]
  );
  const excludeCredentials = existingCreds?.ids
    ? existingCreds.ids.split(",").map((id) => ({ id }))
    : [];

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.display_name,
    userDisplayName: user.display_name,
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    // @simplewebauthn/server defaults this to 60s, which is too short for a
    // cross-device (QR + Bluetooth) phone registration — scanning, pairing,
    // unlocking, and confirming routinely takes longer on a first attempt.
    // Match the server-side challenge TTL instead.
    timeout: CHALLENGE_TTL_SECONDS * 1000,
  });

  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString();
  run(
    `INSERT INTO challenges (user_id, purpose, challenge, expires_at, consumed)
     VALUES (?, 'register', ?, ?, 0)
     ON CONFLICT(user_id, purpose) DO UPDATE SET challenge = excluded.challenge, expires_at = excluded.expires_at, consumed = 0`,
    [userId, options.challenge, expiresAt]
  );

  audit(userId, "register.begin", { deviceLabel });
  res.json({ options, deviceLabel });
});

/** readme.md §6.1 steps 4-6 — verify attestation, persist public key only, advance lifecycle. */
registerRouter.post("/finish", async (req, res) => {
  const userId = String(req.body?.userId ?? "");
  const response = req.body?.response as RegistrationResponseJSON | undefined;
  const user = getUser(userId);
  if (!user || !response) return res.status(400).json({ error: "userId and response are required" });

  const challengeRow = row<{ challenge: string; expires_at: string; consumed: number }>(
    "SELECT challenge, expires_at, consumed FROM challenges WHERE user_id = ? AND purpose = 'register'",
    [userId]
  );
  if (!challengeRow || challengeRow.consumed) {
    audit(userId, "register.finish.no_challenge");
    return res.status(400).json({ error: "no pending registration challenge" });
  }
  if (new Date(challengeRow.expires_at).getTime() < Date.now()) {
    audit(userId, "register.finish.expired");
    return res.status(400).json({ error: "challenge expired" });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });
  } catch (err) {
    audit(userId, "register.finish.verify_error", { message: (err as Error).message });
    return res.status(400).json({ error: "attestation verification failed" });
  }

  // consume the challenge regardless of outcome below (single-use)
  run("UPDATE challenges SET consumed = 1 WHERE user_id = ? AND purpose = 'register'", [userId]);

  if (!verification.verified || !verification.registrationInfo) {
    audit(userId, "register.finish.not_verified");
    return res.status(400).json({ error: "registration not verified" });
  }

  const deviceLabel = expectedDeviceForStatus(user.status);
  const { credentialID, credentialPublicKey, counter, aaguid } = verification.registrationInfo;

  run(
    `INSERT INTO credentials (id, user_id, cred_id, public_key, sign_count, aaguid, transports, device_label, role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      userId,
      credentialID,
      Buffer.from(credentialPublicKey).toString("base64url"),
      counter,
      aaguid ?? null,
      JSON.stringify(response.response.transports ?? []),
      deviceLabel === "replacement" ? String(req.body?.replacementLabel ?? "laptop") : deviceLabel,
      deviceLabel === "security_key" ? "recovery" : "primary",
    ]
  );

  if (user.status === "RECOVERY") {
    // Replacement authenticator enrolled after a recovery-code redemption —
    // restores full trust directly, no PENDING staging (readme.md §6.5).
    reactivateViaRecovery(userId);
  } else {
    advanceAfterRegistration(userId, deviceLabel ?? "unknown");
  }
  const updated = getUser(userId)!;
  audit(userId, "register.finish.ok", { deviceLabel });

  res.json({ registered: true, deviceLabel, accountStatus: updated.status });
});
