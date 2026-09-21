import { Router } from "express";
import { run } from "../db/index.js";
import { getUser, getUserByEmail } from "../services/ceremonyApi.js";
import { issueRecoveryCodeSet, verifyAndConsumeRecoveryCode } from "../services/recoveryCodes.js";
import { issueSession, sessionCookieName, sessionCookieOptions } from "../services/session.js";
import { audit } from "../services/audit.js";

export const recoveryRouter = Router();

/**
 * Issues (or reissues) the written recovery-code set. Rank 3 in the recovery
 * hierarchy — readme.md §6.5. In a production deployment this must require
 * an already-elevated session; the demo build trusts the caller-supplied
 * userId, matching the same simplification noted for /stepup/challenge.
 */
recoveryRouter.post("/codes/issue", async (req, res) => {
  const userId = String(req.body?.userId ?? "");
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
