import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { SessionStore } from "../../data/sessions.js";
import { SESSION_TTL_MS } from "../../data/sessions.js";
import type { ApiKeyStore } from "../../data/api-keys.js";
import { resolvePermissionContext, type PermissionStore, type GuestPermissions } from "../../data/permissions.js";
import type { GuestModeConfig } from "../../data/config.js";
import {
  validateSessionFromHeaders,
  extractSessionToken,
  SESSION_COOKIE_NAME,
} from "../auth/validateSession.js";
import { extractApiKey } from "../auth/api-key-header.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: {
      id: string;
      username: string;
      role: "admin" | "member" | "guest";
      capabilities?: Set<string>;
      bots?: "all" | Set<string>;
      guest?: GuestPermissions;
    };
    /** How this request authenticated: browser session cookie or API key. */
    authMethod?: "session" | "api-key";
  }
}

export function createRequireAuth(
  sessions: SessionStore,
  permissions: PermissionStore,
  getGuestConfig: () => GuestModeConfig,
  apiKeys?: ApiKeyStore
): RequestHandler {
  return function requireAuth(req: Request, res: Response, next: NextFunction) {
    // ─── API-key path ──────────────────────────────────────────────────────
    // A key in a header authenticates on its own; cookies are ignored on this
    // path so the two credential types can never be mixed.
    const rawKey = extractApiKey(req);
    if (rawKey !== null) {
      const validation = apiKeys?.validateAndTouch(rawKey) ?? null;
      if (!validation) {
        res.status(401).json({ error: "invalid api key" });
        return;
      }
      const ctx = resolvePermissionContext(validation.role, validation.userId, permissions);
      req.user = {
        id: validation.userId,
        username: validation.username,
        role: validation.role,
        capabilities: ctx.capabilities,
        bots: ctx.bots,
      };
      req.authMethod = "api-key";
      next();
      return;
    }

    // ─── Session-cookie path (browser) ─────────────────────────────────────
    const result = validateSessionFromHeaders(req.headers.cookie, sessions);
    if (!result) {
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    // A guest session is only valid while guest mode is enabled. Disabling it
    // immediately invalidates any in-flight guest sessions.
    const guestCfg = getGuestConfig();
    if (result.role === "guest" && !guestCfg.enabled) {
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const ctx = resolvePermissionContext(
      result.role,
      result.userId,
      permissions,
      result.role === "guest" ? { bots: guestCfg.bots, permissions: guestCfg.permissions } : undefined
    );
    req.user = {
      id: result.userId,
      username: result.username,
      role: result.role,
      capabilities: ctx.capabilities,
      bots: ctx.bots,
      guest: ctx.guest,
    };
    req.authMethod = "session";
    const token = extractSessionToken(req.headers.cookie);
    if (token) {
      res.cookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.secure,
        path: "/",
        maxAge: SESSION_TTL_MS,
      });
    }
    next();
  };
}
