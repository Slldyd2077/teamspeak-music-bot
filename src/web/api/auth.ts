import { Router } from "express";
import type { Request, Response } from "express";
import type { MusicProvider } from "../../music/provider.js";
import type { CookieStore, CookiePlatform } from "../../music/auth.js";
import type { BotManager } from "../../bot/manager.js";
import type { BotInstance } from "../../bot/instance.js";
import type { Logger } from "../../logger.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";

type Platform = "netease" | "qq" | "bilibili" | "youtube" | "local" | "kugou";

/**
 * Per-bot platform auth router. Every platform-login operation is scoped to a
 * specific bot: the bot owns its own provider instances (each with its own
 * cookie), and cookies persist per (botId, platform). botId is required — there
 * is no global/default account (that was the pre-isolation leak).
 */
export function createAuthRouter(
  botManager: BotManager,
  cookieStore: CookieStore,
  logger: Logger,
): Router {
  const router = Router();

  function botIdFrom(req: Request): string | undefined {
    const q = req.query.botId;
    if (typeof q === "string" && q) return q;
    const b = (req.body as { botId?: unknown } | undefined)?.botId;
    return typeof b === "string" && b ? b : undefined;
  }

  /** Resolve the bot from botId (query for GET, body for POST). Sends 400/404. */
  function resolveBot(req: Request, res: Response): BotInstance | null {
    const botId = botIdFrom(req);
    if (!botId) {
      res.status(400).json({ error: "botId is required" });
      return null;
    }
    const bot = botManager.getBot(botId);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return null;
    }
    return bot;
  }

  function providerFor(bot: BotInstance, platform?: string): MusicProvider {
    return bot.getProviderFor((platform ?? "netease") as Platform);
  }

  function cookiePlatform(platform?: string): CookiePlatform {
    return platform === "bilibili" ? "bilibili"
      : platform === "kugou" ? "kugou"
      : platform === "qq" ? "qq"
      : "netease";
  }

  router.get("/status", requireNotGuest, async (req, res) => {
    try {
      const platform = req.query.platform as string;
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, platform);
      const status = await provider.getAuthStatus();
      logger.debug({ platform, botId: bot.id, status }, "Auth status check");
      res.json({ platform: provider.platform, ...status });
    } catch (err) {
      logger.error({ err }, "Auth status check failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/qrcode", requirePermission("platform.auth"), async (req, res) => {
    try {
      const { platform } = req.body;
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, platform);
      const qr = await provider.getQrCode();
      logger.info({ platform, botId: bot.id, key: qr.key }, "QR code generated");
      res.json(qr);
    } catch (err) {
      logger.error({ err }, "QR code generation failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/qrcode/status", requireNotGuest, async (req, res) => {
    try {
      const { key, platform } = req.query;
      if (!key) {
        res.status(400).json({ error: "key is required" });
        return;
      }
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, platform as string);
      const status = await provider.checkQrCodeStatus(key as string);
      logger.info({ platform, botId: bot.id, status, key }, "QR status check");

      // When confirmed, persist this bot's cookie.
      if (status === "confirmed") {
        const cookie = provider.getCookie();
        if (cookie) {
          const plat = cookiePlatform(platform as string);
          cookieStore.save(bot.id, plat, cookie);
          logger.info({ platform: plat, botId: bot.id }, "Cookie persisted to disk");
        }
      }

      res.json({ status });
    } catch (err) {
      logger.error({ err }, "QR status check failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/sms/send", requirePermission("platform.auth"), async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) {
        res.status(400).json({ error: "phone is required" });
        return;
      }
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, "netease");
      if (!provider.sendSmsCode) {
        res.status(400).json({ error: "SMS login not supported for this platform" });
        return;
      }
      const success = await provider.sendSmsCode(phone);
      res.json({ success });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/sms/verify", requirePermission("platform.auth"), async (req, res) => {
    try {
      const { phone, code } = req.body;
      if (!phone || !code) {
        res.status(400).json({ error: "phone and code are required" });
        return;
      }
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, "netease");
      if (!provider.loginWithSms) {
        res.status(400).json({ error: "SMS login not supported" });
        return;
      }
      const success = await provider.loginWithSms(phone, code);
      if (success) {
        cookieStore.save(bot.id, "netease", provider.getCookie());
      }
      res.json({ success });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/cookie", requirePermission("platform.auth"), (req, res) => {
    const { platform, cookie } = req.body;
    if (!cookie) {
      res.status(400).json({ error: "cookie is required" });
      return;
    }
    // YouTube has no cookie concept — reject instead of falling through and
    // clobbering the NetEase cookie entry.
    if (platform === "youtube") {
      res
        .status(400)
        .json({ error: "YouTube does not use cookies (uses yt-dlp binary)" });
      return;
    }
    const bot = resolveBot(req, res);
    if (!bot) return;
    const provider = providerFor(bot, platform);
    provider.setCookie(cookie);
    cookieStore.save(bot.id, cookiePlatform(platform), cookie);
    res.json({ success: true });
  });

  return router;
}
