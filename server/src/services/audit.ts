import { run } from "../db/index.js";

/** Append-only audit trail. Never update or delete a row from here. */
export function audit(userId: string | null, event: string, detail?: Record<string, unknown>) {
  run(
    "INSERT INTO audit_log (user_id, event, detail) VALUES (?, ?, ?)",
    [userId, event, detail ? JSON.stringify(detail) : null]
  );
}
