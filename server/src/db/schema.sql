-- MFA for blind users — schema (see readme.md §5, PDF §9)
-- SQLite via node:sqlite. No private key, no reversible secret, is ever stored.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,       -- internal key only; never shown to the user
  display_name    TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE, -- human-facing identifier, used for recovery lookup
  -- PENDING_LAPTOP -> PENDING_PHONE -> PENDING_KEY -> PENDING_CODE_CONFIRM -> ACTIVE
  -- -> LOCKED (5 failures) -> RECOVERY -> ACTIVE
  status          TEXT NOT NULL DEFAULT 'PENDING_LAPTOP',
  failed_stepup_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Public keys only. Credential ID + COSE public key, never a private key.
CREATE TABLE IF NOT EXISTS credentials (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cred_id         TEXT NOT NULL UNIQUE,      -- base64url credential ID
  public_key      TEXT NOT NULL,             -- base64url COSE public key
  sign_count      INTEGER NOT NULL DEFAULT 0,
  aaguid          TEXT,
  transports      TEXT,                      -- JSON array
  device_label    TEXT NOT NULL,             -- 'laptop' | 'phone' | 'security_key'
  role            TEXT NOT NULL,             -- 'primary' | 'recovery'
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single active step-up code per user. Only an Argon2id hash is ever stored.
CREATE TABLE IF NOT EXISTS stepup_codes (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash       TEXT NOT NULL,             -- Argon2id(C_n)
  generation      INTEGER NOT NULL DEFAULT 0,
  consumed        INTEGER NOT NULL DEFAULT 0,
  issued_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Written recovery codes: 8 per set, Argon2id-hashed, single-use.
CREATE TABLE IF NOT EXISTS recovery_codes (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash       TEXT NOT NULL,
  used            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Server-held, single-use WebAuthn challenges (registration + assertion).
CREATE TABLE IF NOT EXISTS challenges (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL,             -- 'register' | 'auth'
  challenge       TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  consumed        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, purpose)
);

-- Append-only audit trail. Every ceremony event, every step-up issue/consume, every failure.
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT,
  event           TEXT NOT NULL,
  detail          TEXT,                      -- JSON
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
