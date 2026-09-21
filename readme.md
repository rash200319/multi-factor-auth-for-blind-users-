# Multi-Factor Authentication System for Visually Impaired Users

CS3053 — Information Security. Implementation guide derived from the group's
`GROUP_Unified_Design.pdf` (Unified Design Document, Submission 2). This README
turns that design into a concrete build plan: architecture, data model, API
contracts, ceremonies, interaction rules, and a milestone-based implementation
order.

Read this alongside the design PDF — this file is the "how to build it", the
PDF is the "why it's built this way" (threat model, WCAG/NIST conformance
mapping, rejected alternatives).

---

## 1. What this system is

A WebAuthn-based MFA system for blind users operating a web app through a
screen reader. Two findings drive every decision:

1. A rendered one-time code is only private for a sighted user at close range.
   **Spoken** output is audible at conversational distance to anyone nearby —
   the confidentiality of the output channel cannot be assumed.
2. A step that requires sight to complete (e.g. scanning a QR code) forces the
   user to hand their credential to a sighted assistant. **Delegation is a
   vulnerability**, not a workaround.

The design responds with three registered authenticators and three factors:

| Factor | Mechanism | When used |
|---|---|---|
| 1 — Possession | Laptop platform passkey **or** phone authenticator (WebAuthn/FIDO2) | Every login |
| 2 — Inherence | Fingerprint (local user verification on the device) | Every login, same gesture as Factor 1 |
| 3 — Knowledge | Single-use security code, spoken over a **verified private audio route** (headphones), memorised, rotated on every use | Step-up only, on risk escalation |
| Recovery | Roaming hardware security key + fingerprint/PIN | Both everyday devices lost — also the WCAG-compliant alternative to Factor 3 |

The account is **unusable** until all three authenticators are registered and
the first step-up code has been confirmed.

Conformance targets: WCAG 2.2 Level AA (incl. SC 3.3.8) + SC 3.3.9 (AAA),
NIST SP 800-63-4 AAL2 with a phishing-resistant option offered.

---

## 2. Non-negotiable design constraints

These come directly from the threat model (WS2) and accessibility analysis
(WS1) in the PDF. Do not relax them for implementation convenience:

- **No CAPTCHA anywhere in any flow.** Ranked the #1 most problematic web
  item by blind users, 2x more likely to be flagged problematic than by
  non-disabled users (WebAIM Survey #10).
- **No QR code enrolment step**, and no step that requires sighted
  assistance to complete. This is what eliminates the semi-trusted-assistant
  threat (T4).
- **No secret is ever displayed or rendered visually.** Nothing to screenshot,
  nothing to shoulder-surf.
- **The step-up code is spoken only after the client verifies a private audio
  route (headphones).** If none is verified, **refuse** the spoken channel and
  offer the security key instead. Never silently fall back to speaker output.
- **Single-use, immediately rotated code.** A code is invalidated the instant
  it's consumed; the next code is issued right after, while the user is still
  wearing the verified headset.
- **No SMS, no email OTP, no knowledge-based questions, no support-agent
  override, no TOTP-with-QR-enrolment.** All excluded in WS3/WS2 (see PDF
  §5.1, §9.1, §11.1) — do not reintroduce them as "quick" recovery paths.
- **Announce state, never appearance.** Use `aria-live="polite"` with
  descriptions like "Touch your fingerprint sensor now" — never "a dialog has
  appeared".
- **The code is never placed in a live region.** Live regions announce
  automatically on whatever output device is currently active, which would
  bypass the containment check. Speak the code only through the explicitly
  verified private route, and only because containment passed — not because
  the DOM changed.

---

## 3. Recommended stack

The design is stack-agnostic (WebAuthn + TLS 1.3 + standard KDFs). Suggested
choices for a course implementation, optimized for a working WebAuthn +
accessible-audio demo without reinventing primitives:

| Layer | Choice | Why |
|---|---|---|
| WebAuthn server | Node.js + [`@simplewebauthn/server`](https://simplewebauthn.dev/) | Handles attestation/assertion verification, origin/rp_id binding, challenge management |
| WebAuthn client | [`@simplewebauthn/browser`](https://simplewebauthn.dev/) | Wraps `navigator.credentials.create/get` |
| Backend framework | Express (or Fastify) | Minimal, easy to map 1:1 onto the ceremony API below |
| Database | PostgreSQL (SQLite acceptable for the course build) | Relational fit for credential/recovery/audit tables |
| Password/code hashing | Argon2id via `argon2` npm package | Matches PDF §9.2 / D2 recovery-code store spec |
| Session/token encryption | `jose` (JWE) or server-side session store | `Enc_key(...)` in the ceremony pseudocode = encrypted session token |
| Frontend | Plain HTML/CSS/JS or React, screen-reader tested | Must pass with JS DOM but no visual rendering assumptions |
| Speech delivery (step-up code) | Server-generated audio via TTS (e.g. OS/browser Speech Synthesis API triggered client-side after containment check) | Code is *spoken*, never typed by the server into a visible field |
| Audio-route check | `navigator.mediaDevices.enumerateDevices()` + explicit user confirmation ("Confirm you are wearing headphones") | PDF flags automated detection as weak (§13.2) — pair with a declared control, don't rely on the API alone |
| TLS | 1.3 only | Required by every ceremony in the design |

If your team already has a stack mandated by the course, swap layers 1:1 —
the ceremony contracts in §6 are the part that must not change.

---

## 4. Project structure

```
multi-factor-auth-for-blind-users-/
├── GROUP_Unified_Design.pdf        # source design doc (already present at repo root's parent)
├── readme.md                       # this file
├── server/
│   ├── src/
│   │   ├── index.ts                # app entry, TLS, route mounting
│   │   ├── routes/
│   │   │   ├── register.ts         # /register/begin, /register/finish
│   │   │   ├── auth.ts             # /auth/begin, /auth/finish
│   │   │   ├── stepup.ts           # /stepup/challenge, /stepup/verify
│   │   │   └── recovery.ts         # /recovery/*
│   │   ├── services/
│   │   │   ├── ceremonyApi.ts      # verifier state machine (Figure 6)
│   │   │   ├── riskEngine.ts       # low/high risk classification -> step-up trigger
│   │   │   ├── stepupCode.ts       # issue / hash / verify / rotate C_n
│   │   │   └── recoveryCodes.ts    # written recovery code lifecycle
│   │   ├── models/                 # credential store, recovery store, audit log
│   │   └── db/                     # migrations, schema
│   └── test/
├── client/
│   ├── src/
│   │   ├── pages/SignIn.tsx
│   │   ├── pages/Enrol.tsx
│   │   ├── components/StepUpPrompt.tsx
│   │   ├── a11y/                   # focus management, aria-live helpers
│   │   └── audio/routeCheck.ts     # private-audio-route confirmation
│   └── test/
└── docs/
    ├── threat-model.md             # summarised from PDF §4
    └── verification-plan.md        # summarised from PDF §12
```

---

## 5. Data model

Matches PDF §9 (component/data model) and Figure 9 (deployment). The server
never stores a private key or a reversible authentication secret.

```sql
-- Public keys only. No private key ever reaches the server (WebAuthn property).
CREATE TABLE credentials (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id),
  cred_id         BYTEA NOT NULL UNIQUE,   -- credential ID from authenticator
  public_key      BYTEA NOT NULL,
  sign_count      BIGINT NOT NULL DEFAULT 0,
  aaguid          UUID,
  device_label    TEXT NOT NULL,           -- 'laptop' | 'phone' | 'security_key'
  role            TEXT NOT NULL,           -- 'primary' | 'recovery'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Step-up code: only an Argon2id hash is ever stored, single generation counter.
CREATE TABLE stepup_codes (
  user_id         UUID PRIMARY KEY REFERENCES users(id),
  code_hash       TEXT NOT NULL,           -- Argon2id(C_n | salt)
  salt            BYTEA NOT NULL,
  generation      BIGINT NOT NULL DEFAULT 0,
  consumed        BOOLEAN NOT NULL DEFAULT false,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Written recovery codes: 8 codes per set, Argon2id per-code salts.
CREATE TABLE recovery_codes (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id),
  code_hash       TEXT NOT NULL,
  salt            BYTEA NOT NULL,
  used            BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only. Every ceremony event, every step-up issue/consume, every failure.
CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID,
  event           TEXT NOT NULL,
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Account state machine (Figure 10): PENDING_* until all 3 credentials + C_1 confirmed.
CREATE TABLE users (
  id              UUID PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'PENDING_LAPTOP',
  -- PENDING_LAPTOP -> PENDING_PHONE -> PENDING_KEY -> PENDING_CODE_CONFIRM -> ACTIVE
  --   -> LOCKED (5 failures) -> RECOVERY -> ACTIVE
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Nothing in `credentials`, `stepup_codes`, or `recovery_codes` is reversible.
A full database breach yields no usable authentication material (PDF AS-8).

---

## 6. Ceremonies (implement these exactly — they are the security argument)

### 6.1 Registration (run 3x: laptop, phone, security key)

```
1.  client -> server : POST /register/begin { user_id }
2.  server            : nonce := CSPRNG(32 bytes); store against user_id, 300s TTL, single-use
    server -> client  : PublicKeyCredentialCreationOptions {
                            challenge: nonce, rp_id, uv: "required",
                            residentKey: "required", excludeCredentials
                        }
3.  client            : navigator.credentials.create(options)
                          -> authenticator prompts local user verification (fingerprint)
                          -> authenticator generates (PK_u, SK_u) bound to rp_id; SK_u never leaves device
4.  client -> server  : POST /register/finish { credId, PK_u, authData, clientData, sig }
5.  server            : verify challenge == nonce; verify origin; verify rp_id_hash;
                        verify flags.UV == 1; verify attestation signature
                        -> persist (user_id, credId, PK_u, sign_count=0, aaguid, device_label)
6.  server -> client  : { registration_complete }
```

Repeat for phone, then security key. **After the phone registration**, issue
the first step-up code (`C_1`) over the verified private audio route and
require the user to repeat it back before the account leaves `PENDING`.

### 6.2 Authentication (routine login — Factors 1+2, no username typed)

```
1.  client -> server : POST /auth/begin { }              -- discoverable credential, no username
2.  server            : nonce := CSPRNG(32); mark unconsumed
    server -> client  : PublicKeyCredentialRequestOptions { challenge: nonce, rp_id, uv: "required" }
3.  client            : navigator.credentials.get(options) -> local UV (fingerprint) -> sig
4.  client -> server  : POST /auth/finish { credId, userHandle, authData, clientData, sig }
5.  server            : verify sig against stored PK_u; challenge == nonce (fresh, unconsumed);
                        origin + rp_id_hash correct; flags.UV == 1;
                        sign_count > stored sign_count  -- else flag possible clone, deny
6.  server            : riskEngine.evaluate(context) -> { low, high }
7a. [low]  server -> client : { session_token }            -- FACTORS 1+2 complete, login ends here
7b. [high] server -> client : { step_up_required }          -- go to 6.3
```

### 6.3 Step-up (Factor 3 — spoken code)

```
1.  client  : verify private audio route (headphone check + explicit user confirmation)
              -- if NOT verified: REFUSE spoken channel, offer security key instead. Stop here.
2.  server  : speak C_n over the verified route only (never render, never place in a live region)
3.  user    : enters C_n from memory
4.  client -> server : Enc_key(C_n)
5.  server  : verify Argon2id(C_n | salt) == stored hash
              -> invalidate C_n permanently (mark consumed, bump generation)
              -> generate C_(n+1); speak it over the private route
              -> require user to repeat C_(n+1) back (confirms capture, not just delivery)
6.  server -> client : { elevated_session }
```

Lockout: 5 consecutive step-up failures -> `LOCKED`, out-of-band notification
sent, no support-agent override permitted (T8 mitigation — see §2).

### 6.4 Risk engine (what triggers step-up)

Implement as an explicit rule table, not a black box — this is what
determines when Factor 3 fires. Minimum rule set for the course build:

- Operation is high-value (payment, credential change, recovery-contact
  change, data export) → always step-up.
- New device / new IP range since last session → step-up.
- `sign_count` anomaly (did not increase) → deny, do not step-up (possible
  clone — see §7 detection, not step-up recovery).
- Otherwise → low risk, Factors 1+2 suffice (AAL2 requires two factors, not
  three; a routine third factor buys no assurance and costs accessibility —
  PDF §5.3).

### 6.5 Recovery hierarchy (implement in this order, nothing above it)

1. The other everyday device (laptop or phone), if still held.
2. Roaming security key + fingerprint/PIN — primary recovery mechanism.
3. Written recovery codes (8 words from the same wordlist, Argon2id-hashed,
   per-code salt) — last resort.
4. Out-of-band identity proofing with mandatory delay + notification to all
   registered contacts — only if the security key is also lost.

**Never implement:** knowledge-based questions, SMS reset, email reset, or a
support-agent override. Each is an unauthenticated path to a fully
authenticated session (PDF §9.1, §11.1).

---

## 7. Server-side verifier state machine

Implement `ceremonyApi.ts` as an explicit state machine (PDF Figure 6):

```
IDLE
  -> CHALLENGE_ISSUED     [begin]           entry: nonce = CSPRNG(32); do/timer 300s
  -> RISK_EVALUATION      [signatures valid: origin + UV + sign_count]
  -> AUTHENTICATED        [risk = low]
  -> STEP_UP_PENDING       [risk = high]     entry: verify permitted alternative (security key) available
  -> ELEVATED               [PIN/code valid]
  -> FAILED                [any check fails] entry: consume nonce; do/exponential backoff
  -> LOCKED                [5 consecutive failures]
  (timeout/inactivity from any state) -> logout
```

Every WCAG 2.2 SC 2.2.1 timing requirement (300s minimum, extendable) is
implemented as a server-side timer property, not a client-side courtesy —
this makes it a testable server property, not a UI nicety that can drift.

---

## 8. Interaction design rules (client)

From PDF §8 / Figure 8 — implement as literal event → mechanism mappings:

| Event | Mechanism | WCAG SC |
|---|---|---|
| Page load | Focus moves to `<h1>` "Sign in" | 2.4.3 |
| Ceremony starts | `aria-live="polite"`: "Touch your fingerprint sensor now" | 4.1.3 |
| Success | Announce, then move focus to `main` | 4.1.3, 2.4.3 |
| Failure | `role="alert"` naming the specific cause and remedy (never a generic "error") | 3.3.1, 3.3.3 |
| Private route absent | `role="alert"` explaining the refusal, offering the security key | 3.3.3 |
| Timeout approaching | `aria-live="assertive"` with an extension control | 2.2.1, 2.2.6 |

Two rules to bake into every component from the start, not bolt on later:

- **Announce state, never appearance.** Describe what happened / what to do,
  never that a UI element appeared.
- **The step-up code must never be placed in an `aria-live` region.** Speak
  it only through the explicit private-audio-route path, gated on the
  containment check having passed.

---

## 9. Security controls checklist (map to PDF §10 before calling a milestone done)

- [ ] `clientData.origin` signed and checked on every ceremony (phishing resistance, T1)
- [ ] `rp_id_hash` bound on every assertion (relay/AiTM resistance)
- [ ] TLS 1.3 enforced, no downgrade path (T5)
- [ ] No SMS/email anywhere in the codebase (T6)
- [ ] No password field anywhere; step-up code is rate-limited (T7)
- [ ] No human-override path in support tooling (T8)
- [ ] Nonces are CSPRNG, single-use, 300s TTL, checked on every finish call (assertion replay)
- [ ] Step-up code hash invalidated **before** the next code is generated (replay of consumed code)
- [ ] `sign_count` strictly increasing check implemented and logged, even though it's a weak signal on some authenticators (cloning detection, PDF §13.7 caveat)
- [ ] Credential store contains public keys only — grep the schema for any private-key or plaintext-secret column before every release
- [ ] Step-up code never logged, never placed in a response body outside the encrypted session exchange

---

## 10. Verification plan (PDF §12 — use as your test plan / Definition of Done)

| Requirement | Test | Pass condition |
|---|---|---|
| Screen-reader-only completion | Full walkthrough with display off, JAWS+Chrome and NVDA+Chrome minimum | Enrolment and login completed using audio + keyboard only |
| Account lifecycle | Inspect state machine | Account unusable until all 3 credentials + `C_1` confirmed |
| WCAG 2.2 AA | Manual audit across the test matrix | No Level A or AA failure |
| Gesture count | Count gestures from page load to session start | ≤ 1 gesture on the routine (Factors 1+2) path |
| Timer behaviour | Inspect timeout implementation | No hard limit below 300s; extension control present |
| Code hygiene | Inspect DOM/network | No CAPTCHA anywhere; step-up code never in a live region; never spoken without a verified private route |
| Test matrix | Run full ceremony on each pairing | JAWS+Chrome, NVDA+Chrome, JAWS+Edge, NVDA+Firefox, VoiceOver+Safari — ceremony completable on each |

Automated accessibility tooling (axe, Lighthouse) is a pre-filter only — it
catches a minority of real barriers. Manual screen-reader walkthroughs are
mandatory before marking any milestone complete.

---

## 11. Suggested implementation order (milestones)

1. **Scaffolding** — repo structure above, DB schema + migrations, TLS-enabled
   dev server.
2. **Registration ceremony** for one authenticator type (laptop platform
   passkey) end-to-end, including the account-PENDING gate.
3. **Extend registration** to phone + security key; implement the blocking
   `PENDING_*` lifecycle (Figure 10) and the `C_1` confirmation step.
4. **Routine authentication ceremony** (Factors 1+2), discoverable credential,
   no username field, session issuance.
5. **Interaction layer**: focus management, `aria-live` announcements, alert
   roles — validate with an actual screen reader before moving on, not after.
6. **Risk engine + step-up ceremony**: private-audio-route check, spoken code
   delivery, single-use rotation, repeat-back confirmation.
7. **Recovery hierarchy**: security-key recovery path, then written recovery
   codes with the Argon2id store.
8. **Audit log + lockout**: 5-failure lockout, out-of-band notification,
   append-only audit trail for every ceremony event.
9. **Security pass**: work through the §9 checklist above line by line.
10. **Verification pass**: run the §10 test matrix, document actual results
    (the design PDF describes the plan but not results — this is where the
    implementation earns that evidence).

---

## 12. Known limitations to carry into the implementation (from PDF §13)

Be explicit about these in your own project docs/demo — don't let the
implementation silently claim more than the design does:

- The step-up code is spoken in full; acoustic containment depends on
  headphone leakage at ordinary volume, which is an **assumption**, not a
  control the system enforces. This is the design's stated principal residual
  weakness.
- `navigator.mediaDevices.enumerateDevices()` only detects the presence of an
  output device, not that audio is actually routed to it — pair it with an
  explicit user confirmation step, not silent trust.
- If users routinely fall back to the security key instead of the spoken
  code, the third factor becomes decorative in practice — worth instrumenting
  (audit log) so this is measurable, not assumed.
- No formal protocol verification and no attestation enforcement — a full
  AAL3 claim is intentionally not made.

---

## 13. References

See PDF §14 for the full list. Key ones relevant to implementation:

- W3C, *Web Authentication: An API for Accessing Public Key Credentials,
  Level 3* — https://www.w3.org/TR/webauthn-3/
- NIST SP 800-63B, *Digital Identity Guidelines: Authentication and
  Authenticator Management* — https://pages.nist.gov/800-63-4/sp800-63b.html
- W3C, *Understanding SC 3.3.8: Accessible Authentication (Minimum)* —
  https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html
- RFC 9106, Argon2 memory-hard password hashing.
- WebAIM, *Screen Reader User Survey #10* — https://webaim.org/projects/screenreadersurvey10/
