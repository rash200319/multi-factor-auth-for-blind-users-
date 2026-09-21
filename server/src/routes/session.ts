import { Router } from "express";
import { readSession, sessionCookieName, sessionCookieOptions } from "../services/session.js";
import { getUser } from "../services/ceremonyApi.js";

export const sessionRouter = Router();

sessionRouter.get("/me", async (req, res) => {
  const token = req.cookies?.[sessionCookieName];
  if (!token) return res.status(401).json({ authenticated: false });

  const claims = await readSession(token);
  if (!claims) return res.status(401).json({ authenticated: false });

  const user = getUser(claims.sub);
  if (!user) return res.status(401).json({ authenticated: false });

  res.json({
    authenticated: true,
    aal: claims.aal,
    userId: user.id,
    displayName: user.display_name,
    accountStatus: user.status,
  });
});

sessionRouter.post("/logout", (_req, res) => {
  res.clearCookie(sessionCookieName, sessionCookieOptions);
  res.json({ loggedOut: true });
});
