import { Router } from "express";
import type { BotDatabase } from "../../data/database.js";
import type { MusicProvider, QrCodeResult } from "../../music/provider.js";
import type { Logger } from "../../logger.js";

/**
 * A provider that can log a web user into their OWN account without touching
 * the bot's shared login, and hand out a view bound to that account (#164).
 */
export interface PersonalLoginProvider {
  getQrCode(): Promise<QrCodeResult>;
  pollQrLogin(key: string): Promise<{ status: "waiting" | "scanned" | "confirmed" | "expired"; cookie?: string }>;
  withCookie(cookie: string): MusicProvider;
}

export function supportsPersonalLogin(
  provider: MusicProvider | undefined,
): provider is MusicProvider & PersonalLoginProvider {
  const p = provider as Partial<PersonalLoginProvider> | undefined;
  return typeof p?.pollQrLogin === "function" && typeof p.withCookie === "function";
}

/**
 * The caller's own NetEase account, used for their personal FM instead of the
 * bot's shared login (#164). Every route acts on req.user only; the cookie is
 * stored server-side and never sent back to the browser.
 */
export function createPersonalMusicRouter(
  database: BotDatabase,
  neteaseProvider: MusicProvider,
  logger: Logger,
): Router {
  const router = Router();
  const platform = "netease";

  router.use((_req, res, next) => {
    if (!supportsPersonalLogin(neteaseProvider)) {
      res.status(501).json({ error: "Personal login not supported" });
      return;
    }
    next();
  });
  const provider = neteaseProvider as MusicProvider & PersonalLoginProvider;

  router.get("/netease/status", async (req, res) => {
    const cookie = database.getUserMusicCookie(req.user!.id, platform);
    if (!cookie) {
      res.json({ linked: false, loggedIn: false });
      return;
    }
    try {
      const status = await provider.withCookie(cookie).getAuthStatus();
      res.json({ linked: true, ...status });
    } catch (err) {
      logger.warn({ err }, "Personal NetEase status check failed");
      res.json({ linked: true, loggedIn: false });
    }
  });

  router.post("/netease/qrcode", async (_req, res) => {
    try {
      res.json(await provider.getQrCode());
    } catch (err) {
      logger.error({ err }, "Personal NetEase QR generation failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/netease/qrcode/status", async (req, res) => {
    const key = req.query.key;
    if (typeof key !== "string" || !key) {
      res.status(400).json({ error: "key is required" });
      return;
    }
    try {
      const { status, cookie } = await provider.pollQrLogin(key);
      if (status === "confirmed" && cookie) {
        database.setUserMusicCookie(req.user!.id, platform, cookie);
        logger.info({ userId: req.user!.id, platform }, "Personal music account linked");
      }
      res.json({ status });
    } catch (err) {
      logger.error({ err }, "Personal NetEase QR status check failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/netease", (req, res) => {
    database.deleteUserMusicCookie(req.user!.id, platform);
    logger.info({ userId: req.user!.id, platform }, "Personal music account unlinked");
    res.json({ ok: true });
  });

  return router;
}
