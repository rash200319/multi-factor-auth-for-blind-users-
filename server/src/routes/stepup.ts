import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import { row, run } from "../db/index.js";
import { RP_ID, ORIGIN, CHALLENGE_TTL_SECONDS } from "../config.js";
import { getUser, confirmFirstStepUpCode, recordStepUpFailure, resetStepUpFailures } from "../services/ceremonyApi.js";
import { issueStepUpCode, verifyAndConsumeStepUpCode, confirmStepUpCodeCapture } from "../services/stepupCode.js";
import { issueSession, sessionCookieName, sessionCookieOptions } from "../services/session.js";
import { audit } from "../services/audit.js";

export const stepupRouter = Router();

/**
 * readme.md §6.3 step 1-2 / §2: the client MUST verify the private audio
 * route (headphones) and pass that confirmation explicitly. If it is not
 * confirmed, the server REFUSES to speak the code — it never falls back to
 * an unverified output device. This is the one place a plaintext step-up
 * code legitimately crosses the wire, and only after this gate passes.
 */
stepupRouter.post("/challenge", async (req, res) => {
  const userId = String(req.body?.userId ?? "");
  const privateRouteConfirmed = Boolean(req.body?.privateRouteConfirmed);
  const user = getUser(userId);
  if (!user) return res.status(404).json({ error: "unknown user" });

  if (!privateRouteConfirmed) {
    audit(userId, "stepup.challenge.refused_no_route");
    return res.status(409).json({
      refused: true,
      reason: "private_audio_route_not_verified",
      alternative: "security_key",
    });
  }

  const { code, generation } = await issueStepUpCode(userId);
  // Response carries the plaintext code once, over TLS, to be spoken
  // client-side via speech synthesis — never rendered to the DOM, never
  // logged (issueStepUpCode's audit call omits it), never placed in a
  // live region.
  res.json({ code, generation });
});

/** readme.md §6.1 step 8 / §6.3 step 5 — "repeat it back" capture confirmation. */
stepupRouter.post("/confirm-capture", async (req, res) => {
  const userId = String(req.body?.userId ?? "");
  const repeatedCode = String(req.body?.repeatedCode ?? "");
  const user = getUser(userId);
  if (!user) return res.status(404).json({ error: "unknown user" });

  const captured = await confirmStepUpCodeCapture(userId, repeatedCode);
  if (!captured) {
    return res.status(400).json({ captured: false });
  }

  if (user.status === "PENDING_CODE_CONFIRM") {
    confirmFirstStepUpCode(userId); // -> ACTIVE
  }
  const updated = getUser(userId)!;
  res.json({ captured: true, accountStatus: updated.status });
});

/**
 * readme.md §6.3 steps 3-6 — used to authorize a high-risk operation flagged
 * by /auth/finish. Verifies + permanently invalidates C_n, then issues and
 * speaks C_(n+1) so the account always has a fresh code ready for next time.
 */
stepupRouter.post("/verify", async (req, res) => {
  const userId = String(req.body?.userId ?? "");
  const submittedCode = String(req.body?.code ?? "");
  const privateRouteConfirmed = Boolean(req.body?.privateRouteConfirmed);
  const user = getUser(userId);
  if (!user) return res.status(404).json({ error: "unknown user" });

  const result = await verifyAndConsumeStepUpCode(userId, submittedCode);

  if (result !== "ok") {
    const lockedNow = recordStepUpFailure(userId);
    return res.status(400).json({ result, locked: lockedNow });
  }

  resetStepUpFailures(userId);
  const token = await issueSession(userId, "aal2-elevated");
  res.cookie(sessionCookieName, token, sessionCookieOptions);

  // Rotate immediately, while the user is still wearing the verified
  // headset (readme.md §7.1). Only speak the next code if the private
  // route is still confirmed for this same interaction.
  if (privateRouteConfirmed) {
    const next = await issueStepUpCode(userId);
    return res.json({ result: "ok", elevated: true, nextCode: next.code, nextGeneration: next.generation });
  }

  res.json({ result: "ok", elevated: true, nextCode: null });
});

/**
 * WCAG 2.2 SC 3.3.8 "Alternative" provision: the registered roaming
 * security key may be presented instead of the spoken code at any step-up
 * prompt — readme.md §5.3, §7.3, Figure 8. This path needs no recall and no
 * transcription, so it works even when containment cannot be verified.
 */
const keyChallenges = new Map<string, { userId: string; challenge: string; expiresAt: number }>();

stepupRouter.post("/key/begin", async (req, res) => {
  const userId = String(req.body?.userId ?? "");
  const user = getUser(userId);
  if (!user) return res.status(404).json({ error: "unknown user" });

  const keyCred = row<{ cred_id: string }>(
    "SELECT cred_id FROM credentials WHERE user_id = ? AND device_label = 'security_key'",
    [userId]
  );
  if (!keyCred) return res.status(409).json({ error: "no registered security key" });

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "required",
    allowCredentials: [{ id: keyCred.cred_id }],
    timeout: CHALLENGE_TTL_SECONDS * 1000, // see register.ts — same 60s-default issue applies here
  });
  const attemptId = randomUUID();
  keyChallenges.set(attemptId, {
    userId,
    challenge: options.challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000,
  });
  audit(userId, "stepup.key.begin");
  res.json({ attemptId, options });
});

stepupRouter.post("/key/finish", async (req, res) => {
  const attemptId = String(req.body?.attemptId ?? "");
  const response = req.body?.response as AuthenticationResponseJSON | undefined;
  const pending = keyChallenges.get(attemptId);
  if (!pending || !response) return res.status(400).json({ error: "no pending attempt" });
  keyChallenges.delete(attemptId);
  if (pending.expiresAt < Date.now()) return res.status(400).json({ error: "challenge expired" });

  const cred = row<{ id: string; cred_id: string; public_key: string; sign_count: number; device_label: string }>(
    "SELECT * FROM credentials WHERE cred_id = ? AND user_id = ? AND device_label = 'security_key'",
    [response.id, pending.userId]
  );
  if (!cred) return res.status(400).json({ error: "unknown security key credential" });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      authenticator: {
        credentialID: cred.cred_id,
        credentialPublicKey: Buffer.from(cred.public_key, "base64url"),
        counter: cred.sign_count,
      },
    });
  } catch (err) {
    audit(pending.userId, "stepup.key.verify_error", { message: (err as Error).message });
    return res.status(400).json({ error: "security key verification failed" });
  }

  if (!verification.verified) {
    audit(pending.userId, "stepup.key.not_verified");
    return res.status(400).json({ error: "security key not verified" });
  }

  run("UPDATE credentials SET sign_count = ? WHERE id = ?", [verification.authenticationInfo.newCounter, cred.id]);
  resetStepUpFailures(pending.userId);
  audit(pending.userId, "stepup.key.ok");

  const token = await issueSession(pending.userId, "aal2-elevated");
  res.cookie(sessionCookieName, token, sessionCookieOptions);
  res.json({ result: "ok", elevated: true });
});
