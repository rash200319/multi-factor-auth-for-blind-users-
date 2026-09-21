export const RP_NAME = process.env.RP_NAME ?? "MFA for Blind Users (Demo)";
export const RP_ID = process.env.RP_ID ?? "localhost";
export const ORIGIN = process.env.ORIGIN ?? "http://localhost:5190";
export const PORT = Number(process.env.PORT ?? 4000);
export const CHALLENGE_TTL_SECONDS = 300; // WCAG 2.2 SC 2.2.1 — 300s minimum, PDF Figure 6

/**
 * DEV-ONLY escape hatch: lets enrolment skip the roaming security key when
 * the tester doesn't own one. This is NOT part of the design in readme.md —
 * the whole point of the third authenticator is removing a single point of
 * failure (PDF §5.2) and providing the WCAG SC 3.3.8 alternative to the
 * spoken code. An account that used this skip has neither. Defaults off;
 * never enable in anything resembling production. Every use is logged to
 * the audit trail as `register.dev_skip_security_key` so a skipped account
 * is always identifiable, never indistinguishable from a real one.
 */
export const DEV_ALLOW_SKIP_SECURITY_KEY = process.env.DEV_ALLOW_SKIP_SECURITY_KEY === "true";
