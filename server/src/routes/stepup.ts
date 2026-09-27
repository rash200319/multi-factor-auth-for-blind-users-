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
import {
  issueSession,
  sessionCookieName,
  sessionCookieOptions,
  stepupTicketCookieName,
  stepupTicketCookieOptions,
} from "../services/session.js";
import { audit } from "../services/audit.js";
import { requireStepUpTicket, resolveCodeIssuanceUser } from "../middleware/auth.js";
import { notifyUser } from "../services/notify.js";
import { stepupChallengeLimiter, stepupVerifyLimiter } from "../middleware/rateLimit.js";

export const stepupRouter = Router();

/**
 * Speaks a code only after the client has verified the private audio route
 * (PDF §7.1 containment: refusal over degradation). If the route is not
 * confirmed, the server REFUSES — it never falls back to an unverified
 * output device, and the client offers the security key instead.
 *
 * This endpoint never serves the code the user must present at step-up:
 * that code (C_n) is entered from memory (PDF §6.2 step 7b.ii). It only
 * issues a code in two situations — see resolveCodeIssuanceUser:
 *  1. Bootstrap: C_1 during enrolment (status PENDING_CODE_CONFIRM).
 *  2. Re-delivery of C_(n+1) inside an elevated session, e.g. the user
 *     did not catch the code spoken by /verify and asks to hear a new one,
 *     or authenticated with the security key and wants a fresh code.
 */
stepupRouter.post("/challenge", resolveCodeIssuanceUser, stepupChallengeLimiter, async (req, res) => {
  const userId = req.userId!;
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

/**
 * "Repeat it back" capture confirmation — PDF §6.1 step 8 (C_1) and §6.2
 * step 7b.iv (C_(n+1)). Non-consuming. Same two trust models as
 * /challenge: bootstrap during enrolment, otherwise an elevated session
 * (the step-up ticket has already been exchanged for one by /verify).
 */
stepupRouter.post("/confirm-capture", resolveCodeIssuanceUser, stepupVerifyLimiter, async (req, res) => {
  const userId = req.userId!;
  const repeatedCode = String(req.body?.repeatedCode ?? "");
  const user = getUser(userId);
  if (!user) return res.status(404).json({ error: "unknown user" });

  const captured = await confirmStepUpCodeCapture(userId, repeatedCode);
  if (!captured) {
    return res.status(400).json({ captured: false });
  }

  if (user.status === "PENDING_CODE_CONFIRM") {
    confirmFirstStepUpCode(userId); // -> ACTIVE
    // The account just went ACTIVE with no login session yet (bootstrap has
    // none to reuse) — issue one now so the rest of enrolment (e.g.
    // /recovery/codes/issue, which requires a session — WI-1) can proceed
    // without a separate sign-in. Mirrors /recovery/redeem's existing
    // immediate-session-on-success pattern.
    const token = await issueSession(userId, "aal2");
    res.cookie(sessionCookieName, token, sessionCookieOptions);
  }
  const updated = getUser(userId)!;
  res.json({ captured: true, accountStatus: updated.status });
});

/**
 * PDF §6.2 step 7b — authorizes a high-risk operation flagged by
 * /auth/finish:
 *   i.   private audio route verified, else REFUSE (use the security key)
 *   ii.  user enters C_n from memory
 *   iii. verify Argon2id hash; invalidate C_n permanently
 *   iv.  generate C_(n+1), speak it, user repeats it back (/confirm-capture)
 *   v.   elevated session
 *
 * Step i is checked BEFORE C_n is touched: C_(n+1) must be spoken in the
 * same interaction, so without a private route the ceremony cannot finish
 * and C_n must not be spent.
 *
 * userId comes from the pending-step-up ticket, never the request body —
 * docs/hardening-plan.md WI-1.
 */
stepupRouter.post("/verify", requireStepUpTicket, stepupVerifyLimiter, async (req, res) => {
  const userId = req.userId!;
  const submittedCode = String(req.body?.code ?? "");
  const privateRouteConfirmed = Boolean(req.body?.privateRouteConfirmed);
  const user = getUser(userId);
  if (!user) return res.status(404).json({ error: "unknown user" });

  if (!privateRouteConfirmed) {
    audit(userId, "stepup.verify.refused_no_route");
    return res.status(409).json({
      refused: true,
      reason: "private_audio_route_not_verified",
      alternative: "security_key",
    });
  }

  const result = await verifyAndConsumeStepUpCode(userId, submittedCode);

  if (result !== "ok") {
    const lockedNow = await recordStepUpFailure(userId);
    return res.status(400).json({ result, locked: lockedNow });
  }

  resetStepUpFailures(userId);
  const token = await issueSession(userId, "aal2-elevated");
  res.cookie(sessionCookieName, token, sessionCookieOptions);
  // The ticket is consumed — it's about to be superseded by a real session
  // and must not remain usable on its own.
  res.clearCookie(stepupTicketCookieName, stepupTicketCookieOptions);
  await notifyStepUp(user.id, user.email, "spoken_code");

  // Rotate immediately, while the user is still wearing the verified
  // headset (PDF §7.1).
  const next = await issueStepUpCode(userId);
  res.json({ result: "ok", elevated: true, nextCode: next.code, nextGeneration: next.generation });
});

/**
 * PDF §7.4 — out-of-band notification on every step-up, so an adversary
 * who consumes a captured code produces a signal the user receives. A
 * delivery failure is audited but does not undo an already-verified step-up.
 */
async function notifyStepUp(userId: string, email: string, method: "spoken_code" | "security_key") {
  try {
    await notifyUser(email, "stepup_completed", { method });
  } catch (err) {
    audit(userId, "notify.failed", { kind: "stepup_completed", message: (err as Error).message });
  }
}

/**
 * WCAG 2.2 SC 3.3.8 "Alternative" provision: the registered roaming
 * security key may be presented instead of the spoken code at any step-up
 * prompt — readme.md §5.3, §7.3, Figure 8. This path needs no recall and no
 * transcription, so it works even when containment cannot be verified.
 */
const keyChallenges = new Map<string, { userId: string; challenge: string; expiresAt: number }>();

stepupRouter.post("/key/begin", requireStepUpTicket, async (req, res) => {
  const userId = req.userId!;
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

stepupRouter.post("/key/finish", requireStepUpTicket, async (req, res) => {
  const attemptId = String(req.body?.attemptId ?? "");
  const response = req.body?.response as AuthenticationResponseJSON | undefined;
  const pending = keyChallenges.get(attemptId);
  if (!pending || !response) return res.status(400).json({ error: "no pending attempt" });
  if (pending.userId !== req.userId) return res.status(403).json({ error: "attempt does not belong to this ticket" });
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

  // Same clone detection as /auth/finish (PDF §10: signCount monotonicity).
  const { newCounter } = verification.authenticationInfo;
  if (newCounter !== 0 && newCounter <= cred.sign_count) {
    audit(pending.userId, "stepup.key.signcount_anomaly", { stored: cred.sign_count, seen: newCounter });
    return res.status(400).json({ error: "authenticator counter anomaly — possible cloned credential" });
  }
  run("UPDATE credentials SET sign_count = ? WHERE id = ?", [newCounter, cred.id]);
  resetStepUpFailures(pending.userId);
  audit(pending.userId, "stepup.key.ok");

  const token = await issueSession(pending.userId, "aal2-elevated");
  res.cookie(sessionCookieName, token, sessionCookieOptions);
  res.clearCookie(stepupTicketCookieName, stepupTicketCookieOptions);
  const user = getUser(pending.userId);
  if (user) await notifyStepUp(user.id, user.email, "security_key");
  res.json({ result: "ok", elevated: true });
});
