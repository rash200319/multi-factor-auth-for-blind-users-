import { run } from "../db/index.js";

/** Append-only audit trail. Never update or delete a row from here. */
export function audit(userId: string | null, event: string, detail?: Record<string, unknown>) {
  run(
    "INSERT INTO audit_log (user_id, event, detail) VALUES (?, ?, ?)",
    [userId, event, detail ? JSON.stringify(detail) : null]
  );

  // Mirror to the server terminal so demos / viva walks show what fired.
  const isSecurityKey =
    event.includes("security_key") ||
    event.includes("stepup.key") ||
    event.includes("dev_skip_security_key") ||
    detail?.deviceLabel === "security_key" ||
    detail?.alternative === "security_key";

  const prefix = isSecurityKey ? "[security-key]" : "[audit]";
  const who = userId ? ` user=${userId.slice(0, 8)}…` : "";
  const extra = detail ? ` ${JSON.stringify(detail)}` : "";
  console.log(`${prefix} ${event}${who}${extra}`);
}
