import { randomInt, randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rows, run } from "../db/index.js";
import { audit } from "./audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORDLIST: string[] = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "wordlist.json"), "utf8")
);

const CODES_PER_SET = 8;
const WORDS_PER_CODE = 4; // ~51.7 bits per code, PDF §9.2

function generateOneRecoveryCode(): string {
  const words = Array.from({ length: WORDS_PER_CODE }, () => WORDLIST[randomInt(WORDLIST.length)]);
  return words.join("-");
}

/**
 * Last-resort recovery mechanism (readme.md §6.5, rank 3 — below the other
 * device and the roaming security key). Replaces any existing set: consuming
 * one code invalidates the rest and forces registration of a replacement
 * authenticator (PDF §9.2), so this also clears prior rows for the user.
 */
export async function issueRecoveryCodeSet(userId: string): Promise<string[]> {
  const plaintextCodes = Array.from({ length: CODES_PER_SET }, generateOneRecoveryCode);

  run("DELETE FROM recovery_codes WHERE user_id = ?", [userId]);
  for (const code of plaintextCodes) {
    const code_hash = await hash(code);
    run(
      "INSERT INTO recovery_codes (id, user_id, code_hash, used) VALUES (?, ?, ?, 0)",
      [randomUUID(), userId, code_hash]
    );
  }

  audit(userId, "recovery.codes.issued", { count: plaintextCodes.length });
  return plaintextCodes; // shown to the user exactly once; server keeps no plaintext copy
}

export type RecoveryVerifyResult = "ok" | "no_match" | "already_used";

/**
 * Verify one written recovery code. On success, invalidates the ENTIRE
 * remaining set (a used code is evidence the written channel may be
 * compromised — PDF §9.2) and the caller must force enrolment of a
 * replacement authenticator.
 */
export async function verifyAndConsumeRecoveryCode(
  userId: string,
  submittedCode: string
): Promise<RecoveryVerifyResult> {
  const candidates = rows<{ id: string; code_hash: string; used: number }>(
    "SELECT id, code_hash, used FROM recovery_codes WHERE user_id = ?",
    [userId]
  );

  const normalized = submittedCode.trim().toLowerCase();
  for (const candidate of candidates) {
    if (candidate.used) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await verify(candidate.code_hash, normalized);
    if (ok) {
      run("UPDATE recovery_codes SET used = 1 WHERE user_id = ?", [userId]); // invalidate whole set
      audit(userId, "recovery.code.consumed", { setSize: candidates.length });
      return "ok";
    }
  }

  const anyUsed = candidates.some((c) => c.used);
  audit(userId, "recovery.code.failed", { reason: anyUsed ? "set_already_used" : "no_match" });
  return anyUsed ? "already_used" : "no_match";
}
