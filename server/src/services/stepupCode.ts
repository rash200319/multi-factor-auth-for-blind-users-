import { randomInt } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { row, run } from "../db/index.js";
import { audit } from "./audit.js";

/**
 * Six-digit numeric code (NIST SP 800-63B verifier-assigned memorised
 * secret floor). Entropy is not the binding constraint: the code is
 * single-use and server-side rate-limited (readme.md §7.2).
 */
export function generateStepUpCode(): string {
  // 000000–999999, always exactly six digits
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Normalise user entry: digits only, so "123 456" and "123-456" still match. */
export function normalizeStepUpCode(submitted: string): string {
  return submitted.replace(/\D/g, "");
}

/**
 * Issue a fresh code for a user, replacing any prior one, and bump the
 * generation counter. Returns the plaintext code — caller is responsible
 * for speaking it over the verified private route and NEVER logging it,
 * NEVER returning it in a response body, and NEVER placing it in a live
 * region (readme.md §2, §8).
 */
export async function issueStepUpCode(userId: string): Promise<{ code: string; generation: number }> {
  const code = generateStepUpCode();
  const code_hash = await hash(code);
  const existing = row<{ generation: number }>(
    "SELECT generation FROM stepup_codes WHERE user_id = ?",
    [userId]
  );
  const generation = (existing?.generation ?? -1) + 1;

  run(
    `INSERT INTO stepup_codes (user_id, code_hash, generation, consumed, issued_at)
     VALUES (?, ?, ?, 0, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       code_hash = excluded.code_hash,
       generation = excluded.generation,
       consumed = 0,
       issued_at = datetime('now')`,
    [userId, code_hash, generation]
  );

  audit(userId, "stepup.code.issued", { generation }); // never log the code itself
  return { code, generation };
}

export type StepUpVerifyResult = "ok" | "no_code" | "already_consumed" | "mismatch";

/** Verify + permanently invalidate on success (single-use — readme.md §6.3 step 5). */
export async function verifyAndConsumeStepUpCode(
  userId: string,
  submittedCode: string
): Promise<StepUpVerifyResult> {
  const rec = row<{ code_hash: string; consumed: number; generation: number }>(
    "SELECT code_hash, consumed, generation FROM stepup_codes WHERE user_id = ?",
    [userId]
  );
  if (!rec) {
    audit(userId, "stepup.verify.no_code");
    return "no_code";
  }
  if (rec.consumed) {
    audit(userId, "stepup.verify.already_consumed", { generation: rec.generation });
    return "already_consumed";
  }

  const ok = await verify(rec.code_hash, normalizeStepUpCode(submittedCode));
  if (!ok) {
    audit(userId, "stepup.verify.mismatch", { generation: rec.generation });
    return "mismatch";
  }

  // Permanently invalidate before anything else happens (blocks replay of a
  // captured code — this is the rotation half of the T2 residual-risk bound).
  run("UPDATE stepup_codes SET consumed = 1 WHERE user_id = ?", [userId]);
  audit(userId, "stepup.verify.ok", { generation: rec.generation });
  return "ok";
}

/**
 * Non-consuming check used only for the "repeat it back" capture-confirmation
 * step (readme.md §6.1 step 8, §6.3 step 5 / Figure 5 step 19). Proves the
 * user actually heard the code correctly without spending it — the code
 * remains available to authorize the next real step-up.
 */
export async function confirmStepUpCodeCapture(userId: string, repeatedCode: string): Promise<boolean> {
  const rec = row<{ code_hash: string; consumed: number }>(
    "SELECT code_hash, consumed FROM stepup_codes WHERE user_id = ?",
    [userId]
  );
  if (!rec || rec.consumed) return false;
  const ok = await verify(rec.code_hash, normalizeStepUpCode(repeatedCode));
  audit(userId, ok ? "stepup.capture.confirmed" : "stepup.capture.mismatch");
  return ok;
}
