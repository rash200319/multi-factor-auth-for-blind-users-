import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

/**
 * Keyed on the authenticated userId (set by requireStepUpTicket /
 * requireSession, which always run before these in the route chain),
 * falling back to IP (via express-rate-limit's own IPv6-safe helper) only
 * if neither ran. docs/hardening-plan.md WI-4.
 *
 * Separate from the 5-failure/30-minute lockout in ceremonyApi.ts, which
 * counts *wrong* codes. This throttles raw request *rate* regardless of
 * correctness, so an attacker can't hammer the endpoint quickly before ever
 * racking up 5 wrong guesses.
 */
const keyFn = (req: Request) => req.userId ?? ipKeyGenerator(req.ip ?? "unknown");

const windowMs = Number(process.env.STEPUP_RATE_LIMIT_WINDOW_MINUTES ?? 15) * 60 * 1000;

export const stepupChallengeLimiter = rateLimit({
  windowMs,
  limit: Number(process.env.STEPUP_CHALLENGE_RATE_LIMIT ?? 5),
  keyGenerator: keyFn,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many step-up requests, try again later" },
});

export const stepupVerifyLimiter = rateLimit({
  windowMs,
  limit: Number(process.env.STEPUP_VERIFY_RATE_LIMIT ?? 10),
  keyGenerator: keyFn,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many step-up verification attempts, try again later" },
});
