import { row, run } from "../db/index.js";
import { audit } from "./audit.js";

/**
 * Account lifecycle state machine — readme.md §5 (users.status) and §7
 * (verifier state machine, PDF Figure 6/10). The account is unusable until
 * all three authenticators are registered AND the first step-up code (C_1)
 * has been confirmed.
 */
export type UserStatus =
  | "PENDING_LAPTOP"
  | "PENDING_PHONE"
  | "PENDING_KEY"
  | "PENDING_CODE_CONFIRM"
  | "ACTIVE"
  | "LOCKED"
  | "RECOVERY";

export interface UserRow {
  id: string;
  display_name: string;
  email: string;
  status: UserStatus;
  failed_stepup_attempts: number;
  locked_until: string | null;
}

export function getUser(userId: string): UserRow | undefined {
  return row<UserRow>("SELECT * FROM users WHERE id = ?", [userId]);
}

/** Recovery is looked up by email, not the internal id — nobody should have to remember a UUID. */
export function getUserByEmail(email: string): UserRow | undefined {
  return row<UserRow>("SELECT * FROM users WHERE email = ? COLLATE NOCASE", [email]);
}

const REGISTRATION_ORDER: Record<UserStatus, UserStatus | null> = {
  PENDING_LAPTOP: "PENDING_PHONE",
  PENDING_PHONE: "PENDING_KEY",
  PENDING_KEY: "PENDING_CODE_CONFIRM",
  PENDING_CODE_CONFIRM: null, // advanced explicitly by confirmStepUpCode(), not by device registration
  ACTIVE: null,
  LOCKED: null,
  RECOVERY: null,
};

/** Which device type must be registered next, given the current status. */
export function expectedDeviceForStatus(status: UserStatus): "laptop" | "phone" | "security_key" | "replacement" | null {
  switch (status) {
    case "PENDING_LAPTOP":
      return "laptop";
    case "PENDING_PHONE":
      return "phone";
    case "PENDING_KEY":
      return "security_key";
    case "RECOVERY":
      // A recovery-code redemption always requires enrolling a replacement
      // authenticator before the account is trusted again (PDF §9.2) —
      // the specific device type is chosen by the user in the client UI.
      return "replacement";
    default:
      return null;
  }
}

/** Call after a credential of `deviceLabel` is durably persisted. */
export function advanceAfterRegistration(userId: string, deviceLabel: string) {
  const user = getUser(userId);
  if (!user) throw new Error("unknown user");
  const next = REGISTRATION_ORDER[user.status];
  if (!next) return; // no-op if out of the registration phase already
  run("UPDATE users SET status = ? WHERE id = ?", [next, userId]);
  audit(userId, "lifecycle.advanced", { from: user.status, to: next, deviceLabel });
}

/** Call once the user has repeated C_1 back correctly (readme.md §6.1 step 8). */
export function confirmFirstStepUpCode(userId: string) {
  const user = getUser(userId);
  if (!user || user.status !== "PENDING_CODE_CONFIRM") return;
  run("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [userId]);
  audit(userId, "lifecycle.advanced", { from: user.status, to: "ACTIVE" });
}

const MAX_STEPUP_FAILURES = 5;

/** Returns true if the user is now locked as a result of this failure. */
export function recordStepUpFailure(userId: string): boolean {
  const user = getUser(userId);
  if (!user) return false;
  const attempts = user.failed_stepup_attempts + 1;
  if (attempts >= MAX_STEPUP_FAILURES) {
    run(
      "UPDATE users SET failed_stepup_attempts = ?, status = 'LOCKED', locked_until = datetime('now', '+30 minutes') WHERE id = ?",
      [attempts, userId]
    );
    audit(userId, "lifecycle.locked", { attempts });
    return true;
  }
  run("UPDATE users SET failed_stepup_attempts = ? WHERE id = ?", [attempts, userId]);
  return false;
}

export function resetStepUpFailures(userId: string) {
  run("UPDATE users SET failed_stepup_attempts = 0 WHERE id = ?", [userId]);
}

export function isLocked(user: UserRow): boolean {
  if (user.status !== "LOCKED") return false;
  if (!user.locked_until) return true;
  return new Date(user.locked_until + "Z").getTime() > Date.now();
}

/** Recovery path re-activates the account once a valid recovery credential is used. */
export function reactivateViaRecovery(userId: string) {
  run(
    "UPDATE users SET status = 'ACTIVE', failed_stepup_attempts = 0, locked_until = NULL WHERE id = ?",
    [userId]
  );
  audit(userId, "lifecycle.recovered");
}
