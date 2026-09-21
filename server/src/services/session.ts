import { EncryptJWT, jwtDecrypt } from "jose";

/**
 * Session tokens are encrypted (JWE), never a bare signed JWT — this is the
 * `Enc_key(session_token)` / `Enc_key(elevated_session)` step in the
 * ceremony pseudocode (readme.md §6.2 step 7a/7b, §6.3 step 6).
 *
 * SESSION_SECRET must be 32 bytes. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
 */
const secretB64 = process.env.SESSION_SECRET;
if (!secretB64) {
  throw new Error(
    "SESSION_SECRET env var is required (32-byte base64url key). See server/.env.example."
  );
}
const key = Buffer.from(secretB64, "base64url");
if (key.length !== 32) {
  throw new Error("SESSION_SECRET must decode to exactly 32 bytes.");
}

export type Aal = "aal2" | "aal2-elevated";

export interface SessionClaims {
  sub: string; // user_id
  aal: Aal;
}

const SESSION_COOKIE = "mfa_session";
const SESSION_TTL_SECONDS = 15 * 60; // routine session
const ELEVATED_TTL_SECONDS = 5 * 60; // step-up elevation is short-lived

export async function issueSession(userId: string, aal: Aal): Promise<string> {
  const ttl = aal === "aal2-elevated" ? ELEVATED_TTL_SECONDS : SESSION_TTL_SECONDS;
  return new EncryptJWT({ sub: userId, aal })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .encrypt(key);
}

export async function readSession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtDecrypt(token, key);
    return { sub: payload.sub as string, aal: payload.aal as Aal };
  } catch {
    return null;
  }
}

// Same-site localhost dev (client and server share the "localhost" site,
// just different ports) works fine with the strict defaults below. Once the
// client is reached through an HTTPS tunnel on its own domain (e.g. testing
// a phone's cross-device passkey flow), client and server become genuinely
// cross-site, and a Strict/Lax cookie set by a fetch() response won't be
// stored or sent at all — SameSite=None requires Secure, which requires the
// cookie-setting response to itself be over HTTPS. Set COOKIE_SAMESITE=none
// and COOKIE_SECURE=true in server/.env for that scenario (see docs in
// tools/README.md); leave both unset for ordinary localhost dev.
const sameSite = (process.env.COOKIE_SAMESITE as "strict" | "lax" | "none" | undefined) ?? "strict";
const secure = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production" || sameSite === "none";

export const sessionCookieName = SESSION_COOKIE;
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite,
  secure,
  path: "/",
};
