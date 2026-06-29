import { Router } from "express";
import type { MusicProvider } from "../../music/provider.js";
import { YouTubeProvider } from "../../music/youtube.js";
import type { Platform } from "../../music/auth.js";
import type { BotManager } from "../../bot/manager.js";
import type { Logger } from "../../logger.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";

export function createAuthRouter(
  botManager: BotManager,
  logger: Logger
): Router {
  const router = Router();
  // YouTube 无 cookie；仅用于 /status 上报 yt-dlp 是否安装
  const youtubeProvider: MusicProvider = new YouTubeProvider();

  const platOf = (p?: string): Platform =>
    p === "qq" ? "qq" : p === "bilibili" ? "bilibili" : "netease";

  /** 取某 bot 的平台 provider（per-bot cookie）。botId 必需。 */
  function providerOf(platform: string | undefined, botId?: string): MusicProvider {
    if (platform === "youtube") return youtubeProvider;
    const plat = platOf(platform);
    if (!botId) throw new Error("botId is required for platform auth");
    const provider = botManager.getProvider(botId, plat);
    if (!provider) throw new Error(`bot ${botId} not found or has no provider`);
    return provider;
  }

  router.get("/status", requireNotGuest, async (req, res) => {
    try {
      const platform = req.query.platform as string;
      const botId = req.query.botId as string | undefined;
      const provider = providerOf(platform, botId);
      const status = await provider.getAuthStatus();
      logger.debug({ platform, botId, status }, "Auth status check");
      res.json({ platform: provider.platform, ...status });
    } catch (err) {
      logger.error({ err }, "Auth status check failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/qrcode", requirePermission("platform.auth"), async (req, res) => {
    try {
      const { platform, botId } = req.body;
      const provider = providerOf(platform, botId);
      const qr = await provider.getQrCode();
      logger.info({ platform, botId, key: qr.key }, "QR code generated");
      res.json(qr);
    } catch (err) {
      logger.error({ err }, "QR code generation failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/qrcode/status", requireNotGuest, async (req, res) => {
    try {
      const { key, platform, botId } = req.query;
      if (!key) {
        res.status(400).json({ error: "key is required" });
        return;
      }
      const provider = providerOf(platform as string, botId as string | undefined);
      const status = await provider.checkQrCodeStatus(key as string);
      logger.info({ platform, botId, status, key }, "QR status check");

      // 确认后持久化 cookie 到该 bot（per-bot）
      if (status === "confirmed") {
        const cookie = provider.getCookie();
        if (cookie) {
          botManager.saveBotCookie(botId as string, platOf(platform as string), cookie);
          logger.info({ platform, botId }, "Cookie persisted for bot");
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
      const { phone, botId } = req.body;
      if (!phone) {
        res.status(400).json({ error: "phone is required" });
        return;
      }
      const provider = providerOf("netease", botId);
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
      const { phone, code, botId } = req.body;
      if (!phone || !code) {
        res.status(400).json({ error: "phone and code are required" });
        return;
      }
      const provider = providerOf("netease", botId);
      if (!provider.loginWithSms) {
        res.status(400).json({ error: "SMS login not supported" });
        return;
      }
      const success = await provider.loginWithSms(phone, code);
      if (success) {
        botManager.saveBotCookie(botId, "netease", provider.getCookie());
      }
      res.json({ success });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/cookie", requirePermission("platform.auth"), (req, res) => {
    const { platform, cookie, botId } = req.body;
    if (!cookie) {
      res.status(400).json({ error: "cookie is required" });
      return;
    }
    if (!botId) {
      res.status(400).json({ error: "botId is required" });
      return;
    }
    // YouTube 无 cookie 概念
    if (platform === "youtube") {
      res.status(400).json({ error: "YouTube does not use cookies (uses yt-dlp binary)" });
      return;
    }
    // 持久化到该 bot + 刷新其内存 provider
    botManager.saveBotCookie(botId, platOf(platform), cookie);
    res.json({ success: true });
  });

  return router;
}
