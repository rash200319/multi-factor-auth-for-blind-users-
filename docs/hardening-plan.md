# Hardening Plan — closing the gaps between "built" and "done"

This tracks five concrete gaps found by auditing the code against `readme.md`
and the design PDF, as of commit `fd52ce8`. Each one is either a feature the
design calls for that has no code at all, or a documented demo shortcut that
must not survive into anything a real user touches. This file is the "how to
build it" for those five — pair it with `readme.md` (the ceremony contracts)
and `docs/threat-model.md` (why each control exists) the same way `readme.md`
itself pairs with the design PDF.

Nothing here is optional polish. Item WI-1 is a live authorization bug —
until it's fixed, this system is not safe to point at real accounts.

---

## 0. Recommended build order

The five items aren't independent — building them in the wrong order means
redoing work. Build in this order:

```
WI-1  Session-based auth on sensitive endpoints  (B, "do first")
   │   introduces the "pending step-up ticket" concept everything
   │   downstream assumes exists
   ▼
WI-0  Shared notification service                (prerequisite, new)
   │   small, no dependencies of its own — build right after WI-1
   │   because WI-2 and WI-3 both need it
   ▼
   ├─▶ WI-2  Lockout notification            (A)
   └─▶ WI-3  Recovery tier 4                 (A)
   ▼
WI-4  Step-up rate limiting                       (A)
   │   keys its limiter on userId — only trustworthy once WI-1 lands
   ▼
WI-5  TLS for production deployment               (B, lowest priority)
      dev/cross-device testing is already covered by tools/tunnel.mjs —
      this item is about a real deployment, not local testing
```

Original labels from the audit are kept in parentheses so this maps 1:1 back
to the findings: **(A)** = feature described in the design but never coded,
**(B)** = known demo simplification that needs tightening.

---

## WI-1 — Session-based authorization on sensitive endpoints (B)

**The bug today:** `/stepup/challenge`, `/stepup/verify`, `/stepup/key/begin`,
`/stepup/key/finish`, and `/recovery/codes/issue` all read `userId` straight
from `req.body`. Nothing proves the caller *is* that user. Anyone who obtains
or guesses a UUID can request a step-up challenge or issue themselves a
written-recovery-code set for someone else's account.

### Why this isn't a one-line fix

The naive fix — "require the session cookie, read `userId` from it instead
of the body" — breaks the real step-up flow. Look at `auth.ts` today: when
`evaluateRisk()` returns `"high"`, `/auth/finish` sets **no cookie at all**
and just returns `{ result: "step_up_required", userId }`. At that point in
the ceremony the user has proven factors 1+2 but does not have a session yet
— that's the whole reason `/stepup/*` exists. So `/stepup/challenge` can't
require the *login* session cookie, because it doesn't exist yet at that
point. It needs its own, narrower proof: "this browser just passed factors
1+2, for this specific user, very recently."

### Design

Introduce a second, purpose-limited cookie — a **pending step-up ticket** —
distinct from the real login session cookie (`mfa_session`):

- New cookie name: `mfa_stepup_ticket`.
- Same encrypted-JWE mechanism as `session.ts` (`EncryptJWT`/`jwtDecrypt`,
  A256GCM) — do not invent a second crypto scheme, extend the existing one.
- New `Aal` value: `"pending_stepup"`. Critically, `/me` in `session.ts` must
  keep reading only the `mfa_session` cookie, never `mfa_stepup_ticket` — a
  pending-stepup ticket must never be usable as proof of being logged in.
- TTL: short. Reuse `CHALLENGE_TTL_SECONDS` (300s) as the ceiling so it can't
  outlive the WebAuthn/step-up ceremony it bridges.

### Files to touch

**`server/src/services/session.ts`**
- Widen `Aal` to `"aal2" | "aal2-elevated" | "pending_stepup"`.
- Add:
  ```ts
  export const stepupTicketCookieName = "mfa_stepup_ticket";
  export async function issueStepUpTicket(userId: string): Promise<string> {
    return new EncryptJWT({ sub: userId, aal: "pending_stepup" })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS)
      .encrypt(key);
  }
  ```
  (`readSession` can be reused as-is for reading it back — it already just
  decrypts and returns `{ sub, aal }`; only the cookie name and issuing
  function are new.)
- Cookie options for the ticket: same `httpOnly`/`sameSite`/`secure` as
  `sessionCookieOptions`, but no need for a matching "clear" export beyond
  what's below.

**New: `server/src/middleware/auth.ts`**
```ts
import type { Request, Response, NextFunction } from "express";
import { readSession, stepupTicketCookieName } from "../services/session.js";

export async function requireStepUpTicket(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[stepupTicketCookieName];
  if (!token) return res.status(401).json({ error: "no pending step-up for this browser" });
  const claims = await readSession(token);
  if (!claims || claims.aal !== "pending_stepup") {
    return res.status(401).json({ error: "step-up ticket invalid or expired" });
  }
  (req as any).userId = claims.sub;
  next();
}

export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[sessionCookieName];
  if (!token) return res.status(401).json({ error: "not authenticated" });
  const claims = await readSession(token);
  if (!claims) return res.status(401).json({ error: "session invalid or expired" });
  (req as any).userId = claims.sub;
  (req as any).aal = claims.aal;
  next();
}
```
(Import `sessionCookieName` alongside `stepupTicketCookieName`.)

**`server/src/routes/auth.ts`**
- On `risk === "high"`: replace the bare JSON response with issuing and
  setting the ticket cookie, and **stop returning `userId` in the body**:
  ```ts
  const ticket = await issueStepUpTicket(user.id);
  res.cookie(stepupTicketCookieName, ticket, sessionCookieOptions);
  return res.json({ result: "step_up_required" });
  ```

**`server/src/routes/stepup.ts`**
- `/challenge`, `/verify`, `/key/begin`, `/key/finish`: add
  `requireStepUpTicket` as route middleware, delete the
  `const userId = String(req.body?.userId ?? "")` line in each, replace with
  `const userId = (req as any).userId as string;`.
- On successful `/verify` and `/key/finish` (the two places that currently
  call `issueSession(userId, "aal2-elevated")`), also
  `res.clearCookie(stepupTicketCookieName, sessionCookieOptions)` right
  after setting the real session cookie — a consumed ticket must not remain
  usable, and it's about to be superseded by a real session anyway.
- `/confirm-capture` needs a **documented exception**, not the same
  treatment: this single endpoint serves two different moments —
  1. **Bootstrap** (`user.status === "PENDING_CODE_CONFIRM"`, confirming
     `C_1` during enrolment) — there is no session and no step-up ticket at
     this point, by construction, same as every `/register/*` call. Keep
     trusting `req.body.userId` **only** for this case, exactly like
     `register.ts` already does. This is not a regression — it's the same,
     already-accepted pre-account-existing trust boundary.
  2. **Post-step-up repeat-back** (`user.status === "ACTIVE"`) — this must
     require `requireStepUpTicket` like its siblings.

  Implementation: don't put `requireStepUpTicket` in the middleware chain
  for this one route (it'd break case 1). Instead, inside the handler:
  ```ts
  stepupRouter.post("/confirm-capture", async (req, res) => {
    const bodyUserId = String(req.body?.userId ?? "");
    const bootstrapUser = getUser(bodyUserId);
    const isBootstrap = bootstrapUser?.status === "PENDING_CODE_CONFIRM";

    let userId: string;
    if (isBootstrap) {
      userId = bodyUserId;
    } else {
      const token = req.cookies?.[stepupTicketCookieName];
      const claims = token ? await readSession(token) : null;
      if (!claims || claims.aal !== "pending_stepup") {
        return res.status(401).json({ error: "step-up ticket invalid or expired" });
      }
      userId = claims.sub;
    }
    // ...rest unchanged, using `userId`
  });
  ```

**`server/src/routes/recovery.ts`**
- `/codes/issue`: add `requireSession` middleware, drop
  `const userId = String(req.body?.userId ?? "")`, use `(req as any).userId`.
  This matches the comment already sitting in that file
  ("must require an already-elevated session").
- `/redeem` stays as-is — it is intentionally pre-session (that's the entire
  point of last-resort recovery: the user has no working credential and no
  session to present). No change here.

**Client**
- `client/src/pages/SignIn.ts`: stop sending `userId` in the body for
  `/stepup/challenge`, `/stepup/verify`, `/stepup/key/begin`,
  `/stepup/key/finish` calls (the fetch wrapper in `api.ts` already sends
  `credentials: "include"`, so the new cookie rides along automatically —
  no wrapper changes needed).
- `client/src/pages/Enrol.ts`: `confirm-capture` call keeps sending
  `userId` in the body (needed for the bootstrap case above) — no change.

### Tests

New `server/test/stepupAuth.test.ts`:
- `/stepup/challenge` with no ticket cookie → 401.
- `/stepup/challenge` with an expired/garbage ticket → 401.
- A ticket issued for user A cannot be reused for user B (there's no
  `userId` in the body anymore to even try mismatching, but assert the
  claim's `sub` is what determines which user's code gets issued).
- `/stepup/confirm-capture` still works with only `userId` in the body when
  `status === PENDING_CODE_CONFIRM` (bootstrap case unchanged).
- `/stepup/confirm-capture` requires a valid ticket when `status === ACTIVE`.
- `/recovery/codes/issue` with no session cookie → 401; with a valid
  `mfa_session` cookie → succeeds as before.

Update existing `server/test/stepupCode.test.ts` /
`server/test/ceremonyApi.test.ts` calls that currently call these services
directly (not through HTTP) — those are unaffected, since the ticket concept
lives in the route layer, not `stepupCode.ts` itself.

### Manual verification

Full curl smoke test (mirrors the existing ones in
`docs/verification-plan.md`):
```
curl -c cookies.txt -b cookies.txt -X POST http://localhost:4000/auth/finish ...   # risk=high
# confirm response has NO userId field, and cookies.txt now has mfa_stepup_ticket
curl -c cookies.txt -b cookies.txt -X POST http://localhost:4000/stepup/challenge -d '{"privateRouteConfirmed":true}'
# confirm this succeeds using ONLY the cookie, no userId in the body
```

### Acceptance criteria

- [ ] No route under `/stepup/*` (except the documented bootstrap branch of
      `/confirm-capture`) or `/recovery/codes/issue` trusts a client-supplied
      `userId` for authorization.
- [ ] `/me` never accepts a `pending_stepup` ticket as a logged-in session.
- [ ] Full enrol → login → step-up → recovery walkthrough still passes
      manually (this is the highest-blast-radius change in this plan — do
      the full manual walkthrough before merging, don't rely on unit tests
      alone).

---

## WI-0 — Shared notification service (new prerequisite for WI-2, WI-3)

Both the lockout notification and recovery-tier-4 need to send an
out-of-band message to the account owner. Build one small, swappable service
once instead of duplicating ad-hoc email code twice.

**Important distinction to document in the code itself:** this is an
*informational alert*, never a code the user types back to authenticate.
The design bans email/SMS **OTP** (readme.md §2, §6.5) because a one-time
code delivered by email is an unauthenticated path into the account. A
notification that says "this happened on your account" and grants no access
by itself is not that — it's exactly what design §6.5 rank 4 asks for. Say
this explicitly in the module docstring so nobody "fixes" it later by
misreading the no-email rule.

### New file: `server/src/services/notify.ts`

```ts
export interface NotificationChannel {
  send(to: string, subject: string, body: string): Promise<void>;
}

class ConsoleChannel implements NotificationChannel {
  async send(to: string, subject: string, body: string) {
    console.log(`[notify] to=${to} subject="${subject}"\n${body}`);
  }
}

let channel: NotificationChannel = new ConsoleChannel();

/** Test-only seam — see server/test/notify.test.ts. */
export function setNotificationChannelForTesting(c: NotificationChannel) {
  channel = c;
}

export type NotificationKind =
  | "lockout"
  | "recovery_tier4_requested"
  | "recovery_tier4_cancelled"
  | "recovery_tier4_completed";

const TEMPLATES: Record<NotificationKind, (detail: Record<string, unknown>) => { subject: string; body: string }> = {
  lockout: (d) => ({
    subject: "Your account was locked after repeated failed sign-in attempts",
    body: `Your account was locked until ${d.lockedUntil}. If this wasn't you, your credentials were not compromised (no password exists on this system), but consider checking your devices.`,
  }),
  recovery_tier4_requested: (d) => ({
    subject: "Account recovery was requested",
    body: `A recovery request was made on your account. If you did not make this request, cancel it immediately by contacting support. It will otherwise take effect at ${d.eligibleAt}.`,
  }),
  recovery_tier4_cancelled: () => ({
    subject: "Account recovery request cancelled",
    body: "A pending recovery request on your account was cancelled.",
  }),
  recovery_tier4_completed: () => ({
    subject: "Account recovery completed",
    body: "Your account recovery request has completed and your account is accessible again pending a replacement authenticator.",
  }),
};

export async function notifyUser(userEmail: string, kind: NotificationKind, detail: Record<string, unknown> = {}) {
  const { subject, body } = TEMPLATES[kind](detail);
  await channel.send(userEmail, subject, body);
}
```

Ship with the console channel as the default (matches the project's
zero-config philosophy — no SMTP account required to run `npm run dev`).
Add an optional SMTP channel behind an env flag so the flow can be tested
for real:

```ts
// only if NOTIFY_CHANNEL=smtp
import nodemailer from "nodemailer";
class SmtpChannel implements NotificationChannel {
  private transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  async send(to: string, subject: string, body: string) {
    await this.transport.sendMail({ from: process.env.SMTP_FROM, to, subject, text: body });
  }
}
if (process.env.NOTIFY_CHANNEL === "smtp") setChannel(new SmtpChannel());
```

### Dependencies

`server/package.json`: add `nodemailer` + `@types/nodemailer` (only needed
if the SMTP path is wired up — the console channel needs nothing new).

### `.env.example` additions

```
# Notification delivery for lockout + recovery-tier-4 alerts (WI-0).
# console = logs to stdout (default, zero config). smtp = real email.
NOTIFY_CHANNEL=console
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_USER=
# SMTP_PASS=
# SMTP_FROM=noreply@example.com
```

### Tests

`server/test/notify.test.ts`: inject a fake `NotificationChannel` via
`setNotificationChannelForTesting`, call `notifyUser`, assert the fake
received exactly the expected `to`/`subject`. Every downstream test (WI-2,
WI-3) reuses this seam instead of hitting a real network/SMTP server.

---

## WI-2 — Lockout notification (A)

**Today:** `recordStepUpFailure` in `ceremonyApi.ts:99-113` flips status to
`LOCKED` and writes an audit row. No one is told.

### Changes

**`server/src/services/ceremonyApi.ts`**
- Import `notifyUser` from `./notify.js`.
- Make `recordStepUpFailure` `async`:
  ```ts
  export async function recordStepUpFailure(userId: string): Promise<boolean> {
    const user = getUser(userId);
    if (!user) return false;
    const attempts = user.failed_stepup_attempts + 1;
    if (attempts >= MAX_STEPUP_FAILURES) {
      run(
        "UPDATE users SET failed_stepup_attempts = ?, status = 'LOCKED', locked_until = datetime('now', '+30 minutes') WHERE id = ?",
        [attempts, userId]
      );
      audit(userId, "lifecycle.locked", { attempts });
      const updated = getUser(userId)!;
      await notifyUser(updated.email, "lockout", { lockedUntil: updated.locked_until });
      return true;
    }
    run("UPDATE users SET failed_stepup_attempts = ? WHERE id = ?", [attempts, userId]);
    return false;
  }
  ```
  (`UserRow` already has no `email` field today — check `getUser`'s
  `SELECT *`; it will include `email` automatically since `schema.sql`
  already has that column. Just widen the `UserRow` interface in
  `ceremonyApi.ts` to declare `email: string` alongside the existing
  fields, so TypeScript knows it's there.)

**`server/src/routes/stepup.ts`**
- `/verify`: change `const lockedNow = recordStepUpFailure(userId);` to
  `const lockedNow = await recordStepUpFailure(userId);`.

### Tests

`server/test/ceremonyApi.test.ts`: extend the existing lockout test — after
the 5th failure, assert (via the injected fake channel from WI-0) that
exactly one `lockout` notification was sent to the user's email, and none
were sent after failures 1-4.

### Docs

Update `readme.md` §0 status table and `docs/verification-plan.md` to move
this from implicit ("audit log only") to "Implemented — see
`server/src/services/notify.ts`".

---

## WI-3 — Recovery tier 4: out-of-band identity proofing (A)

**Today:** `recovery.ts` implements tier 3 (written codes) only. If a user
loses their devices, security key, *and* written codes, there is no way back
into the account at all.

### Scope decision (state this explicitly, don't silently under-deliver)

The design calls this "out-of-band identity proofing." A course-scope build
cannot integrate real government-ID verification — and readme.md §13
already admits "no formal protocol verification... a full AAL3 claim is
intentionally not made." Keep that same honesty here: tier 4 is implemented
as a **freeform identity statement + mandatory delay + mandatory
notification**, not real KYC. The security property this tier actually
provides is the delay + notification, not the proofing text — that's
consistent with how the design frames it (§6.5: "mandatory delay +
notification" is the control; "identity proofing" bounds who can plausibly
be asking). Document this limitation in `readme.md` §12 alongside the
existing acoustic-containment caveat once built.

### Data model

Add to `server/src/db/schema.sql` (new table, `CREATE TABLE IF NOT EXISTS`
— no migration framework needed, matches every other table in this file):

```sql
-- Recovery tier 4 (readme.md §6.5 rank 4) — only reachable when the roaming
-- security key AND written recovery codes are both unavailable. Delay +
-- mandatory notification is the control; proof_detail is a self-reported
-- identity statement, not verified KYC (see docs/hardening-plan.md WI-3).
CREATE TABLE IF NOT EXISTS recovery_requests (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'PENDING_DELAY', -- PENDING_DELAY -> COMPLETED | CANCELLED
  proof_detail    TEXT,                      -- JSON, self-reported statement
  requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
  eligible_at     TEXT NOT NULL,             -- requested_at + RECOVERY_TIER4_DELAY_HOURS
  completed_at    TEXT
);
```

### Config

`server/src/config.ts`:
```ts
export const RECOVERY_TIER4_DELAY_HOURS = Number(process.env.RECOVERY_TIER4_DELAY_HOURS ?? 72);
```
`.env.test` should override this to something like `0.001` (a few seconds)
so tests don't need to wait 72 hours — same pattern the project would need
for `locked_until`, just make it configurable here since `datetime('now',
'+N hours')` needs `N` to vary.

### New service: `server/src/services/recoveryTier4.ts`

```ts
import { randomUUID } from "node:crypto";
import { row, run, rows } from "../db/index.js";
import { RECOVERY_TIER4_DELAY_HOURS } from "../config.js";
import { audit } from "./audit.js";
import { notifyUser } from "./notify.js";
import { getUser, getUserByEmail } from "./ceremonyApi.js";

export async function requestTier4Recovery(email: string, statement: string) {
  const user = getUserByEmail(email);
  if (!user) return { ok: false as const, reason: "no_account" };

  const existing = row<{ id: string }>(
    "SELECT id FROM recovery_requests WHERE user_id = ? AND status = 'PENDING_DELAY'",
    [user.id]
  );
  if (existing) return { ok: false as const, reason: "already_pending" };

  const id = randomUUID();
  const eligibleAt = new Date(Date.now() + RECOVERY_TIER4_DELAY_HOURS * 3600_000).toISOString();
  run(
    `INSERT INTO recovery_requests (id, user_id, proof_detail, eligible_at)
     VALUES (?, ?, ?, ?)`,
    [id, user.id, JSON.stringify({ statement }), eligibleAt]
  );
  audit(user.id, "recovery.tier4.requested", { requestId: id, eligibleAt });
  await notifyUser(user.email, "recovery_tier4_requested", { eligibleAt });
  return { ok: true as const, requestId: id, eligibleAt };
}

export async function cancelTier4Recovery(requestId: string) {
  const req = row<{ id: string; user_id: string; status: string }>(
    "SELECT id, user_id, status FROM recovery_requests WHERE id = ?", [requestId]
  );
  if (!req || req.status !== "PENDING_DELAY") return { ok: false as const };
  run("UPDATE recovery_requests SET status = 'CANCELLED' WHERE id = ?", [requestId]);
  audit(req.user_id, "recovery.tier4.cancelled", { requestId });
  const user = getUser(req.user_id)!;
  await notifyUser(user.email, "recovery_tier4_cancelled");
  return { ok: true as const };
}

export async function completeTier4Recovery(requestId: string) {
  const req = row<{ id: string; user_id: string; status: string; eligible_at: string }>(
    "SELECT id, user_id, status, eligible_at FROM recovery_requests WHERE id = ?", [requestId]
  );
  if (!req || req.status !== "PENDING_DELAY") return { ok: false as const, reason: "not_pending" };
  if (new Date(req.eligible_at).getTime() > Date.now()) {
    return { ok: false as const, reason: "delay_not_elapsed" };
  }
  run("UPDATE recovery_requests SET status = 'COMPLETED', completed_at = datetime('now') WHERE id = ?", [requestId]);
  audit(req.user_id, "recovery.tier4.completed", { requestId });
  const user = getUser(req.user_id)!;
  await notifyUser(user.email, "recovery_tier4_completed");
  return { ok: true as const, userId: req.user_id };
}
```

### Routes: add to `server/src/routes/recovery.ts`

```ts
recoveryRouter.post("/tier4/request", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const statement = String(req.body?.statement ?? "").trim();
  if (!statement) return res.status(400).json({ error: "an identity statement is required" });
  const result = await requestTier4Recovery(email, statement);
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.status(201).json({ requestId: result.requestId, eligibleAt: result.eligibleAt });
});

recoveryRouter.post("/tier4/cancel", async (req, res) => {
  const requestId = String(req.body?.requestId ?? "");
  const result = await cancelTier4Recovery(requestId);
  if (!result.ok) return res.status(409).json({ error: "not a pending request" });
  res.json({ cancelled: true });
});

recoveryRouter.post("/tier4/finish", async (req, res) => {
  const requestId = String(req.body?.requestId ?? "");
  const result = await completeTier4Recovery(requestId);
  if (!result.ok) return res.status(409).json({ error: result.reason });

  run("UPDATE users SET status = 'RECOVERY' WHERE id = ?", [result.userId]);
  const token = await issueSession(result.userId, "aal2-elevated");
  res.cookie(sessionCookieName, token, sessionCookieOptions);
  res.json({ result: "ok", userId: result.userId, accountStatus: "RECOVERY", nextStep: "register_replacement_authenticator" });
});
```

(`/tier4/finish` deliberately mirrors `/redeem`'s existing shape — same
`RECOVERY` status handoff into the already-built replacement-authenticator
flow in `register.ts`, so nothing downstream of "account is back in
`RECOVERY` status" needs to change.)

### Client

New minimal UI in `client/recover.html` / `client/src/pages/Recover.ts`: a
"lost everything" link that reveals the statement textarea + submit, and
(separately, for the legitimate owner reacting to an unwanted request) a
"cancel this request" link driven by the request ID included in the
notification email. Keep it behind the existing accessibility rules (§8 of
readme.md) — announce state changes via `announcePolite`, never a raw
"success" toast.

### Tests — `server/test/recoveryTier4.test.ts`

- Request creates a row, sends exactly one notification, returns `eligibleAt`
  in the future.
- A second request while one is `PENDING_DELAY` is rejected (`409`,
  `already_pending`).
- `finish` before `eligible_at` → `409 delay_not_elapsed`.
- `finish` after `eligible_at` (set `.env.test`'s
  `RECOVERY_TIER4_DELAY_HOURS` near-zero) → succeeds, sets `users.status =
  'RECOVERY'`, sends completion notification.
- `finish` called twice → second call fails (`not_pending`, already
  `COMPLETED`).
- `cancel` on a pending request → status `CANCELLED`, subsequent `finish`
  fails.

### Docs

- `readme.md` §6.5: mark rank 4 "Implemented — `server/src/services/recoveryTier4.ts`."
- `docs/threat-model.md`: add a row mapping tier 4 to T8 — note explicitly
  that this is *not* a human-override path (the thing T8 warns against):
  it's a fully automated, delayed, notified, self-service flow with no
  support-agent judgment call anywhere in it.

---

## WI-4 — Step-up rate limiting (A)

**Today:** `stepupCode.ts:17` claims the code is "server-side rate-limited."
It is not — grepped, no rate-limiting package or middleware exists anywhere
in `server/`.

**Do this after WI-1.** The limiter should key on the authenticated
`userId`, not a value an attacker controls — before WI-1 lands, the only
trustworthy key available is the caller's IP, which is a weaker (but still
useful) fallback. If WI-1 isn't done yet for some reason, key on IP and
revisit once it is.

### Dependency

`server/package.json`: add `express-rate-limit`. In-memory store is fine for
a single-instance deployment (this project runs one Node process against a
local SQLite file — no horizontal scaling to plan for here). Note in the
code comment that a Redis-backed store would be needed if that ever changes.

### New file: `server/src/middleware/rateLimit.ts`

```ts
import rateLimit from "express-rate-limit";

// Keyed on userId (set by requireStepUpTicket/requireSession — WI-1),
// falling back to IP only if neither ran first.
const keyFn = (req: any) => req.userId ?? req.ip;

export const stepupChallengeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.STEPUP_CHALLENGE_RATE_LIMIT ?? 5),
  keyGenerator: keyFn,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many step-up requests, try again later" },
});

export const stepupVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.STEPUP_VERIFY_RATE_LIMIT ?? 10),
  keyGenerator: keyFn,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many step-up verification attempts, try again later" },
});
```

This is deliberately separate from the existing 5-failure/30-minute lockout
in `ceremonyApi.ts` — that counts *wrong* codes and locks the account; this
throttles raw *request rate* regardless of correctness, closing the gap
where an attacker could otherwise hammer the endpoint quickly before ever
racking up 5 wrong guesses.

### Wiring — `server/src/routes/stepup.ts`

Add as route middleware, after `requireStepUpTicket`:
```ts
stepupRouter.post("/challenge", requireStepUpTicket, stepupChallengeLimiter, async (req, res) => { ... });
stepupRouter.post("/verify", requireStepUpTicket, stepupVerifyLimiter, async (req, res) => { ... });
```

Order matters: auth middleware first (so `req.userId` exists for the
limiter's `keyGenerator`), rate limiter second.

### `.env.example` additions
```
STEPUP_CHALLENGE_RATE_LIMIT=5
STEPUP_VERIFY_RATE_LIMIT=10
```
And in `.env.test`, set both much higher (e.g. `1000`) so the existing test
suite's rapid-fire calls don't start tripping 429s unrelated to what they're
testing.

### Client

`client/src/pages/SignIn.ts`: handle a `429` response distinctly from a
wrong-code `400` — surface it through `renderAlert()` with the actual cause
("too many attempts") and a remedy ("try again later"), not the generic
mismatch message. This matters for the accessibility rules in readme.md §8
(never a generic "error").

### Tests

`server/test/stepupRateLimit.test.ts`: set a low limit via env, fire N+1
rapid requests at `/stepup/verify` through the HTTP layer (not the service
directly — this is route-middleware behavior), assert the last one is
`429` before it ever reaches `verifyAndConsumeStepUpCode`.

### Docs

Update the §9 security checklist in `readme.md` — the "step-up code is
rate-limited (T7)" line can finally be checked off for real.

---

## WI-5 — TLS for production deployment (B, lowest priority)

**Today:** dev server runs plain HTTP; `index.ts` logs a reminder at boot.
`tools/tunnel.mjs` already solves real-HTTPS-for-testing (cross-device
passkey pairing) via a Cloudflare quick tunnel — **that gap is closed**.
What's still missing is guidance/config for an actual deployment, which is
a different problem (no tunnel involved, a real domain + real cert).

This is genuinely lower priority than WI-1 through WI-4: it's infrastructure
config, not an application-layer bug, and the existing tunnel tooling means
nothing about the design is currently *untested* under HTTPS. Treat this as
the last item, and scope it small.

### Plan (kept intentionally minimal)

1. **Document, don't build, the standard path.** Add a short
   `docs/deployment.md`: run the Express app exactly as today behind a
   TLS-terminating reverse proxy (Caddy is the easiest — automatic
   Let's Encrypt certs from a two-line Caddyfile). State the two things that
   must change for a real deployment, both already-supported by existing
   config:
   - `ORIGIN` / `RP_ID` in `server/.env` must be the real HTTPS origin, not
     `localhost` (same mechanism `tools/tunnel.mjs` already exercises for
     tunnels — a real deployment is the same idea, permanent instead of
     temporary).
   - `COOKIE_SAMESITE` / `COOKIE_SECURE` follow the same rule already
     documented in `tools/README.md`: only needed if the client and API end
     up on different registrable domains; same-domain-different-path or
     same-origin deployments can leave the localhost defaults.
2. **Example Caddyfile** (`docs/examples/Caddyfile`):
   ```
   your-domain.example {
     reverse_proxy /api/* localhost:4000
     reverse_proxy /* localhost:5190
   }
   ```
   (adjust path-based routing to however client/API are actually split in
   the real deployment — this is illustrative, not prescriptive).
3. **Optional, only if time allows:** a `USE_HTTPS` dev flag in
   `server/src/config.ts` + branch in `index.ts` to run the dev server
   itself over `node:https` with a locally-trusted `mkcert` cert, for people
   who want HTTPS without the tunnel's random-URL churn. This is a
   nice-to-have, not required — `tools/tunnel.mjs` already covers the one
   scenario (cross-device phone pairing) that actually needs real HTTPS
   today.

### Acceptance criteria

- [ ] `docs/deployment.md` exists and states the `ORIGIN`/`RP_ID`/cookie
      requirements for a non-localhost deployment.
- [ ] A reference reverse-proxy config exists (doesn't need to be deployed
      anywhere for this course build — it needs to exist and be correct).

---

## Definition of done (aggregate)

- [ ] WI-1: every sensitive endpoint derives `userId` from a cookie the
      server issued, not from client-supplied data (bootstrap exceptions in
      `/register/*` and the documented branch of `/confirm-capture` are the
      only exceptions, and they're intentional).
- [ ] WI-0: `notify.ts` exists, console channel works with zero config, SMTP
      channel works when configured.
- [ ] WI-2: 5th step-up failure sends a notification, verified by test.
- [ ] WI-3: a user who has lost every other recovery method can request,
      wait out, and complete tier-4 recovery; every state transition sends a
      notification; no human-override path was introduced anywhere in it.
- [ ] WI-4: `/stepup/challenge` and `/stepup/verify` return `429` under
      rapid-fire abuse, verified by test; the readme §9 checklist item for
      this is checked off truthfully.
- [ ] WI-5: deployment doc + example reverse-proxy config exist.
- [ ] `readme.md` §0 status table, §6.5, §9, and §12 updated to match
      reality — this file's whole purpose is to stop the docs from
      describing more than the code does, so don't let it become exactly
      that problem itself once these land.
- [ ] Full manual walkthrough (enrol → login → step-up → lockout →
      tier-4 recovery → replacement authenticator) run once, end to end,
      after all five items are merged — not just unit tests in isolation.
