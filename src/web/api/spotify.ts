import { Router } from "express";
import type { Logger } from "pino";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";

/** Minimal structural seam over SpotifyOAuth so this router needs no real
 *  network/crypto in tests. The concrete SpotifyOAuth satisfies it verbatim. */
export interface SpotifyOAuthLike {
  buildAuthorizeUrl(): { url: string; state: string };
  handleCallback(code: string, state: string): Promise<boolean>;
  isAuthorized(): boolean;
}

export interface SpotifyRouterOptions {
  oauth: SpotifyOAuthLike;
  logger: Logger;
  /** Process-wide backend info for /status (single Premium account, Stage 3). */
  getBackendInfo: () => { backend: string; deviceName: string };
  /** Web UI page to bounce the browser back to after the OAuth callback. */
  webUiRedirect?: string;
}

export function createSpotifyRouter(opts: SpotifyRouterOptions): Router {
  const { oauth, logger } = opts;
  const redirectBase = opts.webUiRedirect ?? "/";
  const sep = redirectBase.includes("?") ? "&" : "?";
  const router = Router();

  // Start the Authorization Code + PKCE flow: hand the WebUI the accounts.spotify.com
  // authorize URL (verifier is stashed by state inside SpotifyOAuth). Gated like the
  // other platform logins in auth.ts.
  router.get("/login", requirePermission("platform.auth"), (_req, res) => {
    try {
      const { url } = oauth.buildAuthorizeUrl();
      res.json({ url });
    } catch (err) {
      logger.error({ err }, "Spotify authorize URL build failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // OAuth redirect target (own-app clientId => redirect_uri points here). This is a
  // top-level browser navigation carrying the SameSite=Lax session cookie, so the
  // global requireAuth passes; state is the CSRF guard for the flow itself. Always
  // redirect (never JSON) so the user lands back in the UI.
  router.get("/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !state) {
      res.redirect(`${redirectBase}${sep}spotify=error`);
      return;
    }
    try {
      const ok = await oauth.handleCallback(code, state);
      res.redirect(`${redirectBase}${sep}spotify=${ok ? "success" : "error"}`);
    } catch (err) {
      logger.error({ err }, "Spotify OAuth callback failed");
      res.redirect(`${redirectBase}${sep}spotify=error`);
    }
  });

  // Whether the (single, process-wide) account is authorized, plus which backend
  // + device name are configured — used by the WebUI to show login-needed state.
  router.get("/status", requireNotGuest, (_req, res) => {
    const info = opts.getBackendInfo();
    res.json({
      authorized: oauth.isAuthorized(),
      backend: info.backend,
      deviceName: info.deviceName,
    });
  });

  return router;
}
