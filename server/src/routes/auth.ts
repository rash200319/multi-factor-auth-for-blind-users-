import { Router } from "express";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import { randomUUID } from "node:crypto";
import { row, run, rows } from "../db/index.js";
import { RP_ID, ORIGIN, CHALLENGE_TTL_SECONDS } from "../config.js";
import { audit } from "../services/audit.js";
import { evaluateRisk } from "../services/riskEngine.js";
import { issueSession, sessionCookieName, sessionCookieOptions } from "../services/session.js";
import { getUser, isLocked } from "../services/ceremonyApi.js";

export const authRouter = Router();

// Anonymous, per-attempt challenge id — discoverable credential means no
// username is typed (readme.md §6.2 step 1), so the challenge cannot be
// keyed by user_id until the assertion comes back and identifies the user.
const anonChallenges = new Map<string, { challenge: string; expiresAt: number }>();

/** readme.md §6.2 step 1-2. */
authRouter.post("/begin", async (_req, res) => {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "required",
    timeout: CHALLENGE_TTL_SECONDS * 1000, // see register.ts — same 60s-default issue applies here
  });
  const attemptId = randomUUID();
  anonChallenges.set(attemptId, {
    challenge: options.challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000,
  });
  res.json({ attemptId, options });
});

/** readme.md §6.2 steps 4-7 — verify, evaluate risk, issue session or demand step-up. */
authRouter.post("/finish", async (req, res) => {
  const attemptId = String(req.body?.attemptId ?? "");
  const response = req.body?.response as AuthenticationResponseJSON | undefined;
  const operation = req.body?.operation as string | undefined; // optional, for risk evaluation

  const pending = anonChallenges.get(attemptId);
  if (!pending || !response) return res.status(400).json({ error: "no pending attempt" });
  anonChallenges.delete(attemptId); // single-use regardless of outcome
  if (pending.expiresAt < Date.now()) return res.status(400).json({ error: "challenge expired" });

  const credIdB64 = response.id;
  const cred = row<{
    id: string;
    user_id: string;
    cred_id: string;
    public_key: string;
    sign_count: number;
    device_label: string;
  }>("SELECT * FROM credentials WHERE cred_id = ?", [credIdB64]);
  if (!cred) {
    audit(null, "auth.finish.unknown_credential");
    return res.status(400).json({ error: "unknown credential" });
  }

  const user = getUser(cred.user_id);
  if (!user) return res.status(400).json({ error: "unknown user" });
  if (isLocked(user)) {
    audit(user.id, "auth.finish.locked_out");
    return res.status(423).json({ error: "account locked", lockedUntil: user.locked_until });
  }

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
    audit(user.id, "auth.finish.verify_error", { message: (err as Error).message });
    return res.status(400).json({ error: "assertion verification failed" });
  }

  if (!verification.verified) {
    audit(user.id, "auth.finish.not_verified");
    return res.status(400).json({ error: "authentication not verified" });
  }

  const { newCounter } = verification.authenticationInfo;
  // signCount must strictly increase; a flat/decreasing counter is treated
  // as a possible clone and denied outright — never silently allowed
  // through step-up (readme.md §6.4, §9 checklist).
  if (newCounter !== 0 && newCounter <= cred.sign_count) {
    audit(user.id, "auth.finish.signcount_anomaly", { stored: cred.sign_count, seen: newCounter });
    return res.status(400).json({ error: "authenticator counter anomaly — possible cloned credential" });
  }
  run("UPDATE credentials SET sign_count = ? WHERE id = ?", [newCounter, cred.id]);

  const priorSessionsFromDevice = rows(
    "SELECT 1 FROM audit_log WHERE user_id = ? AND event = 'auth.finish.ok' LIMIT 1",
    [user.id]
  );
  const risk = evaluateRisk({
    operation,
    isNewDevice: priorSessionsFromDevice.length === 0,
    isNewNetworkRange: false, // demo build: no IP-range tracking; extend here for production
    signCountOk: true,
  });

  audit(user.id, "auth.finish.ok", { deviceLabel: cred.device_label, risk, operation: operation ?? null });

  if (risk === "low") {
    const token = await issueSession(user.id, "aal2");
    res.cookie(sessionCookieName, token, sessionCookieOptions);
    return res.json({ result: "session_established", accountStatus: user.status });
  }

  return res.json({ result: "step_up_required", userId: user.id });
});
