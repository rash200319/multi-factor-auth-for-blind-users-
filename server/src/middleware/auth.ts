import type { Request, Response, NextFunction } from "express";
import {
  readSession,
  sessionCookieName,
  stepupTicketCookieName,
  type Aal,
} from "../services/session.js";
import { getUser } from "../services/ceremonyApi.js";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      aal?: Aal;
    }
  }
}

/**
 * Requires a valid pending-step-up ticket (issued by /auth/finish on
 * risk=high) and sets req.userId from it. This is NOT a login session —
 * see the Aal docstring in session.ts. docs/hardening-plan.md WI-1.
 */
export async function requireStepUpTicket(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[stepupTicketCookieName];
  if (!token) return res.status(401).json({ error: "no pending step-up for this browser" });

  const claims = await readSession(token);
  if (!claims || claims.aal !== "pending_stepup") {
    return res.status(401).json({ error: "step-up ticket invalid or expired" });
  }

  req.userId = claims.sub;
  req.aal = claims.aal;
  next();
}

/**
 * Resolves req.userId for the endpoints that ISSUE or CONFIRM a spoken code
 * (/stepup/challenge, /stepup/confirm-capture), BEFORE the route's rate
 * limiter runs — otherwise the limiter's userId-based keying (rateLimit.ts)
 * never has a userId to key on and silently falls back to shared-IP keying.
 *
 * Two trust models:
 *  1. Bootstrap (C_1 at enrolment): trusts body.userId, only when that user
 *     is genuinely mid-enrolment (PENDING_CODE_CONFIRM).
 *  2. Rotation (C_(n+1)): requires an ELEVATED session — i.e. the user has
 *     already presented C_n from memory, or the security key.
 *
 * A pending step-up ticket is deliberately NOT enough: at step-up the user
 * enters C_n from memory (PDF §6.2 step 7b.ii). If factors 1+2 alone could
 * get a fresh code spoken, the knowledge factor would add nothing.
 */
export async function resolveCodeIssuanceUser(req: Request, res: Response, next: NextFunction) {
  const bodyUserId = String(req.body?.userId ?? "");
  const bootstrapUser = bodyUserId ? getUser(bodyUserId) : undefined;

  if (bootstrapUser?.status === "PENDING_CODE_CONFIRM") {
    req.userId = bodyUserId;
    return next();
  }

  const token = req.cookies?.[sessionCookieName];
  const claims = token ? await readSession(token) : null;
  if (!claims || claims.aal !== "aal2-elevated") {
    return res.status(401).json({ error: "complete step-up first — enter your current code from memory, or use your security key" });
  }
  req.userId = claims.sub;
  req.aal = claims.aal;
  next();
}

/**
 * Requires a valid login session (mfa_session) and sets req.userId/req.aal
 * from it. Use for endpoints that must not trust a client-supplied userId
 * (e.g. /recovery/codes/issue). docs/hardening-plan.md WI-1.
 */
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[sessionCookieName];
  if (!token) return res.status(401).json({ error: "not authenticated" });

  const claims = await readSession(token);
  if (!claims || claims.aal === "pending_stepup") {
    return res.status(401).json({ error: "session invalid or expired" });
  }

  req.userId = claims.sub;
  req.aal = claims.aal;
  next();
}
