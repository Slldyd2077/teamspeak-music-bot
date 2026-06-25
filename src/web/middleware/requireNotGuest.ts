import type { Request, Response, NextFunction } from "express";

/** Allow admins and members; deny login-less guests (used for config reads
 *  that must never leak to guests, e.g. GET /api/bot/settings, GET /api/music/quality). */
export function requireNotGuest(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: "unauthenticated" }); return; }
  if (req.user.role === "guest") { res.status(403).json({ error: "forbidden" }); return; }
  next();
}
