import { randomUUID } from "node:crypto";
import { row, run } from "../db/index.js";
import { RECOVERY_TIER4_DELAY_HOURS } from "../config.js";
import { audit } from "./audit.js";
import { notifyUser } from "./notify.js";
import { getUser, getUserByEmail } from "./ceremonyApi.js";

/**
 * Recovery tier 4 (readme.md §6.5 rank 4) — last-resort recovery when the
 * roaming security key AND the written recovery codes are both gone. Not
 * real identity verification (course-scope simplification, documented in
 * readme.md §12 and docs/hardening-plan.md WI-3) — the security property
 * this tier actually provides is the mandatory delay + notification, which
 * gives the real account owner a chance to object before it completes.
 * Never a human-override path (readme.md §2, §6.5): fully automated,
 * delayed, and notified, with no support-agent judgment call anywhere.
 */

export type Tier4RequestResult =
  | { ok: true; requestId: string; eligibleAt: string }
  | { ok: false; reason: "no_account" | "already_pending" };

export async function requestTier4Recovery(email: string, statement: string): Promise<Tier4RequestResult> {
  const user = getUserByEmail(email);
  if (!user) return { ok: false, reason: "no_account" };

  const existing = row<{ id: string }>(
    "SELECT id FROM recovery_requests WHERE user_id = ? AND status = 'PENDING_DELAY'",
    [user.id]
  );
  if (existing) return { ok: false, reason: "already_pending" };

  const id = randomUUID();
  const eligibleAt = new Date(Date.now() + RECOVERY_TIER4_DELAY_HOURS * 3600_000).toISOString();
  run(
    `INSERT INTO recovery_requests (id, user_id, proof_detail, eligible_at)
     VALUES (?, ?, ?, ?)`,
    [id, user.id, JSON.stringify({ statement }), eligibleAt]
  );
  audit(user.id, "recovery.tier4.requested", { requestId: id, eligibleAt });
  await notifyUser(user.email, "recovery_tier4_requested", { eligibleAt });
  return { ok: true, requestId: id, eligibleAt };
}

export async function cancelTier4Recovery(requestId: string): Promise<boolean> {
  const req = row<{ id: string; user_id: string; status: string }>(
    "SELECT id, user_id, status FROM recovery_requests WHERE id = ?",
    [requestId]
  );
  if (!req || req.status !== "PENDING_DELAY") return false;

  run("UPDATE recovery_requests SET status = 'CANCELLED' WHERE id = ?", [requestId]);
  audit(req.user_id, "recovery.tier4.cancelled", { requestId });
  const user = getUser(req.user_id)!;
  await notifyUser(user.email, "recovery_tier4_cancelled");
  return true;
}

export type Tier4CompleteResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "not_pending" | "delay_not_elapsed" };

export async function completeTier4Recovery(requestId: string): Promise<Tier4CompleteResult> {
  const req = row<{ id: string; user_id: string; status: string; eligible_at: string }>(
    "SELECT id, user_id, status, eligible_at FROM recovery_requests WHERE id = ?",
    [requestId]
  );
  if (!req || req.status !== "PENDING_DELAY") return { ok: false, reason: "not_pending" };
  if (new Date(req.eligible_at).getTime() > Date.now()) {
    return { ok: false, reason: "delay_not_elapsed" };
  }

  run("UPDATE recovery_requests SET status = 'COMPLETED', completed_at = datetime('now') WHERE id = ?", [requestId]);
  audit(req.user_id, "recovery.tier4.completed", { requestId });
  const user = getUser(req.user_id)!;
  await notifyUser(user.email, "recovery_tier4_completed");
  return { ok: true, userId: req.user_id };
}
