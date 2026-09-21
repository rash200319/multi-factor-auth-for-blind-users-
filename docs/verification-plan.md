# Verification Plan

Full detail: `GROUP_Unified_Design.pdf` §12. This file tracks what has
actually been run against this codebase, split into what a machine can check
and what only a human screen-reader user can check — automated tooling is a
pre-filter, never a substitute, for the second category.

## Status

| Requirement | Method | Pass condition | Status |
|---|---|---|---|
| FR-1, FR-2, FR-3 (enrolment/login completable) | Task walkthrough, screen output disabled | Enrolment and login completed using audio + keyboard only | **Not yet run** — needs a human tester with JAWS or NVDA |
| FR-5 (account lifecycle) | Automated unit tests | Account unusable until 3 credentials + `C_1` confirmed | **Done** — `server/test/ceremonyApi.test.ts` |
| FR-7, NFR-1 (WCAG 2.2 AA) | Manual audit across test matrix | No Level A/AA failure | **Not yet run** |
| NFR-2 (gesture count) | Manual walkthrough count | ≤ 1 gesture on the routine path | **Not yet run** |
| NFR-3 (timer behaviour) | Code inspection + manual test | No hard limit below 300s, extension present | **Implemented** — `server/src/config.ts CHALLENGE_TTL_SECONDS`, `client/src/a11y/timer.ts`; not yet exercised against a real timeout |
| NFR-4, NFR-7 (code hygiene) | Code inspection | No CAPTCHA; no secret in a live region; never spoken without a verified private route | **Implemented and spot-checked** — see `client/src/a11y/announce.ts` docstring and `server/src/routes/stepup.ts` gate; confirmed via `curl` smoke test that `/stepup/challenge` refuses with HTTP 409 when `privateRouteConfirmed` is false |
| Containment | Acoustic measurement | Leakage intelligibility below threshold at 1m, default volume | **Not run** — requires physical audio equipment, flagged as AS-6 / limitation #5 in the design PDF |
| Test matrix | Full ceremony per pairing | Completable on JAWS+Chrome, NVDA+Chrome, JAWS+Edge, NVDA+Firefox, VoiceOver+Safari | **Not yet run** |
| Core security logic | Automated unit tests | Single-use code enforcement, recovery-set invalidation, risk-engine rules, lockout | **Done** — `server/test/*.test.ts`, 18/18 passing |

## What has been run so far

```
npm run test --workspace server   # 18/18 passing — see server/test/
```

Covers: step-up code single-use + rotation, capture-confirmation without
consumption, recovery-code-set invalidation on first use, account lifecycle
ordering (laptop → phone → key → code-confirm → active), 5-failure lockout,
and the risk-engine rule table.

Manual smoke test against a running server (no browser, curl only) confirmed:
- `/register/begin` returns valid `PublicKeyCredentialCreationOptions`.
- `/auth/begin` returns discoverable-credential request options (no username
  required).
- `/stepup/challenge` returns HTTP 409 and refuses to issue a code when
  `privateRouteConfirmed` is `false`.
- `/recovery/redeem` rejects an unrecognised code with `no_match`.
- The audit log records every event above with **no plaintext code ever
  written to it** — confirmed by inspecting `mfa.sqlite` directly.

## What still requires a human

WebAuthn ceremonies need a real authenticator (Windows Hello, a phone
authenticator, or a physical security key) and cannot be meaningfully
exercised by an automated agent. Before treating this implementation as
"verified" rather than "built", a human needs to:

1. Run the full enrolment ceremony (`client/enrol.html`) end to end with a
   real fingerprint sensor and a real phone/security key.
2. Repeat with a screen reader running (JAWS or NVDA at minimum — PDF §3
   shows these cover ~46% of the surveyed population) and the monitor off.
3. Trigger a step-up (any high-value operation, or force `isNewDevice` in
   `riskEngine.ts` during testing) with real headphones on, and confirm the
   code is audible only to the wearer.
4. Time out a ceremony deliberately and confirm the extension control works.
5. Redeem a recovery code and confirm the replacement-authenticator flow
   completes and the account returns to `ACTIVE`.

Automated accessibility tools (axe-core, Lighthouse) can be added as a
pre-filter in CI, but per the design PDF's own finding, they catch only a
minority of real barriers — steps 1-5 above are not optional.
