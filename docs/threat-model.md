# Threat Model (summary)

Full detail: `GROUP_Unified_Design.pdf` §4. This file is the quick-reference
version, kept next to the code it constrains.

## Adversaries

| ID | Adversary | Population-specific? |
|---|---|---|
| T1 | Remote phishing attacker / adversary-in-the-middle | No, but elevated — visual URL inspection is unavailable |
| T2 | Proximate acoustic eavesdropper | **Yes** |
| T3 | Visual observer or camera | No |
| T4 | Semi-trusted assistant (carer, relative, colleague) | **Yes** |
| T5 | Network attacker | No |
| T6 | SIM-swap attacker | No |
| T7 | Credential-stuffing bot | No |
| T8 | Support-desk social engineer | No, but the path most often weakened "for accessibility" |
| T9 | Endpoint malware | Out of scope (design assumption AS-7) |

## Security goals

| ID | Goal |
|---|---|
| G1 | Mutual authentication without visual inspection |
| G2 | Phishing resistance (verifier-impersonation resistance) |
| G3 | Replay resistance |
| G4 | Acoustic containment: no secret on an uncontained audio channel, bounded value if captured |
| G5 | Recovery without assurance downgrade |
| G6 | Independence of assistance (eliminates T4) |

## Where each threat is handled in this codebase

| Threat | Code location | Mechanism |
|---|---|---|
| T1 (phishing) | `server/src/routes/register.ts`, `auth.ts` — `expectedOrigin`, `expectedRPID` checks | WebAuthn origin + rp_id binding via `@simplewebauthn/server` |
| T2 (acoustic capture) | `server/src/services/stepupCode.ts`, `client/src/audio/routeCheck.ts` | Private-route gate before speaking + single-use rotation on consumption |
| T3 (visual observation) | Entire client — no secret is ever rendered | `client/src/a11y/announce.ts` forbids codes in live regions |
| T4 (semi-trusted assistant) | `server/src/routes/register.ts` — no QR code, resident-key WebAuthn only | Nothing to hand to an assistant; no shared secret ever exists |
| T5 (network attacker) | TLS termination (deploy-time) + `rp_id_hash`/origin binding | Standard WebAuthn/TLS properties |
| T6 (SIM swap) | N/A by construction | No SMS anywhere in the codebase — grep confirms |
| T7 (credential stuffing) | N/A by construction | No password field exists |
| T8 (support-desk social engineering) | `server/src/routes/recovery.ts` | No human-override path; recovery requires either the registered device, key, or written codes |
| Authenticator cloning | `server/src/routes/auth.ts` — `signCount` monotonicity check | Hard deny (not step-up) on a non-increasing counter |
| Replay of an assertion | `server/src/routes/auth.ts`, `stepup.ts` — single-use, TTL-bound nonces | `challenges` table, `anonChallenges`/`keyChallenges` maps |
| Replay of a step-up code | `server/src/services/stepupCode.ts` | `consumed` flag flipped before any other side effect |

## Residual risks (not eliminated — see readme.md §12 / PDF §13)

- **T2, bounded not blocked.** If headphone containment fails, the code is
  disclosed in full. Rotation bounds the exposure to one use; it does not
  prevent disclosure. This is the design's stated principal weakness.
- **Written recovery codes, if recorded insecurely.** The security-key
  alternative removes the *need* to write anything down, not the *option*.
