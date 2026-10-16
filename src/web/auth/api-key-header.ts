import type { Request } from "express";
import { SESSION_COOKIE_NAME } from "./validateSession.js";

/**
 * Extract a raw API key from the `X-API-Key` header or an
 * `Authorization: Bearer <key>` header. Returns null when neither is present.
 */
export function extractApiKey(req: Request): string | null {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const match = /^bearer\s+(.+)$/i.exec(auth);
    if (match) {
      const key = match[1].trim();
      if (key) return key;
    }
  }
  return null;
}

export function hasApiKeyCredential(req: Request): boolean {
  return extractApiKey(req) !== null;
}

/**
 * API-key clients (no session cookie) skip the origin check entirely. Requests
 * that ALSO carry the session cookie must NOT rely on this — an attacker page
 * can set arbitrary headers while the victim's cookie rides along ambiently,
 * so the cookie keeps the request under the origin check.
 */
export function isApiKeyOnlyRequest(req: Request): boolean {
  return hasApiKeyCredential(req) && !req.headers.cookie?.includes(`${SESSION_COOKIE_NAME}=`);
}
