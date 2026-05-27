import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { SessionStore } from "../../data/sessions.js";
import { validateSessionFromHeaders, SESSION_COOKIE_NAME } from "../auth/validateSession.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: { id: string; username: string };
  }
}

export function createRequireAuth(sessions: SessionStore): RequestHandler {
  return function requireAuth(req: Request, res: Response, next: NextFunction) {
    const result = validateSessionFromHeaders(req.headers.cookie, sessions);
    if (!result) {
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    req.user = { id: result.userId, username: result.username };
    next();
  };
}
