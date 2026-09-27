import { Router } from "express";
import { run } from "../db/index.js";
import { getUser, getUserByEmail } from "../services/ceremonyApi.js";
import { confirmRecoveryCodeCapture, issueRecoveryCodeSet, verifyAndConsumeRecoveryCode } from "../services/recoveryCodes.js";
import { requestTier4Recovery, cancelTier4Recovery, completeTier4Recovery } from "../services/recoveryTier4.js";
import { issueSession, sessionCookieName, sessionCookieOptions } from "../services/session.js";
import { audit } from "../services/audit.js";
import { requireSession } from "../middleware/auth.js";

export const recoveryRouter = Router();

/**
 * Issues (or reissues) the written recovery-code set. Rank 3 in the recovery
 * hierarchy — readme.md §6.5. Requires an authenticated session (userId
 * comes from the session cookie, never the request body) — this was a
 * demo-only simplification, closed per docs/hardening-plan.md WI-1.
 */
recoveryRouter.post("/codes/issue", requireSession, async (req, res) => {
  const userId = req.userId!;
  const user = getUser(userId);
  if (!user) return res.status(404).json({ error: "unknown user" });
  if (user.status !== "ACTIVE") {
    return res.status(409).json({ error: "recovery codes can only be issued to an active account" });
  }

  const codes = await issueRecoveryCodeSet(userId);
  // Shown to the user exactly once in this response. Server retains only
  // the Argon2id hashes (recoveryCodes.ts) — there is no "view again".
  res.json({ codes });
});

/**
 * PDF §9.2 — the user types one of the just-issued codes back so enrolment
 * verifies the codes were actually captured (saved, embossed, copied), not
 * merely rendered. Non-consuming: the set stays intact.
 */
recoveryRouter.post("/codes/confirm", requireSession, async (req, res) => {
  const userId = req.userId!;
  const code = String(req.body?.code ?? "");
  const captured = await confirmRecoveryCodeCapture(userId, code);
  if (!captured) return res.status(400).json({ captured: false });
  res.json({ captured: true });
});

/**
 * Last-resort recovery: both everyday devices AND the security key are
 * gone. Looked up by EMAIL, not the internal account id — nobody should
 * have to remember a UUID for this. Redeeming a code re-activates the
 * account but the entire set is invalidated and a replacement authenticator
 * enrolment is required next (readme.md §6.5, PDF §9.2) — handled by
 * /register/begin once status is RECOVERY.
 */
recoveryRouter.post("/redeem", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const code = String(req.body?.code ?? "");
  const user = getUserByEmail(email);
  if (!user) return res.status(404).json({ error: "no account found for that email" });

  const result = await verifyAndConsumeRecoveryCode(user.id, code);
  if (result !== "ok") {
    return res.status(400).json({ result });
  }

  run("UPDATE users SET status = 'RECOVERY' WHERE id = ?", [user.id]);
  audit(user.id, "lifecycle.recovery_pending_replacement");

  const token = await issueSession(user.id, "aal2-elevated");
  res.cookie(sessionCookieName, token, sessionCookieOptions);
  res.json({
    result: "ok",
    userId: user.id, // client needs this to drive the replacement /register/* calls in this same session
    accountStatus: "RECOVERY",
    nextStep: "register_replacement_authenticator",
  });
});

/**
 * Recovery tier 4 (readme.md §6.5 rank 4, docs/hardening-plan.md WI-3) —
 * only meaningful once tiers 1-3 are exhausted (other device, security key,
 * written codes all gone). Not real identity verification: the security
 * property is the mandatory delay + notification below, not the statement
 * text — see the module docstring in services/recoveryTier4.ts.
 */
recoveryRouter.post("/tier4/request", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const statement = String(req.body?.statement ?? "").trim();
  if (!statement) return res.status(400).json({ error: "an identity statement is required" });

  const result = await requestTier4Recovery(email, statement);
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.status(201).json({ requestId: result.requestId, eligibleAt: result.eligibleAt });
});

/**
 * Lets the real account owner cancel a request they didn't make, after
 * seeing the notification — this is the entire security property of tier 4.
 * No session required: the owner may have lost every credential, which is
 * why they're here in the first place.
 */
recoveryRouter.post("/tier4/cancel", async (req, res) => {
  const requestId = String(req.body?.requestId ?? "");
  const cancelled = await cancelTier4Recovery(requestId);
  if (!cancelled) return res.status(409).json({ error: "not a pending request" });
  res.json({ cancelled: true });
});

recoveryRouter.post("/tier4/finish", async (req, res) => {
  const requestId = String(req.body?.requestId ?? "");
  const result = await completeTier4Recovery(requestId);
  if (!result.ok) return res.status(409).json({ error: result.reason });

  run("UPDATE users SET status = 'RECOVERY' WHERE id = ?", [result.userId]);
  const token = await issueSession(result.userId, "aal2-elevated");
  res.cookie(sessionCookieName, token, sessionCookieOptions);
  res.json({
    result: "ok",
    userId: result.userId,
    accountStatus: "RECOVERY",
    nextStep: "register_replacement_authenticator",
  });
});
