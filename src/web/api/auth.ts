import { Router } from "express";
import type { Request, Response } from "express";
import type { MusicProvider } from "../../music/provider.js";
import type { CookieStore, CookiePlatform } from "../../music/auth.js";
import type { BotManager } from "../../bot/manager.js";
import type { BotInstance } from "../../bot/instance.js";
import type { Logger } from "../../logger.js";
import type { BotConfig, JellyfinConfig } from "../../data/config.js";
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
  _config: BotConfig | undefined,
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

  // ─── Jellyfin (per-bot connection) ─────────────────────────────────────
  // Jellyfin has no QR/cookie flow — each bot's connection is configured with
  // its own credentials, persisted as a JSON blob in the bot's cookie slot.
  // The live provider instance is reconfigured in place so a save takes effect
  // without reconnecting the bot.
  type JellyfinCapable = MusicProvider & {
    configure?: (cfg: JellyfinConfig) => void;
    testConnection?: (
      candidate?: JellyfinConfig,
    ) => Promise<{ ok: boolean; serverName?: string; version?: string; error?: string }>;
  };

  function jellyfinForBot(
    req: Request,
    res: Response,
  ): { bot: BotInstance; provider: JellyfinCapable } | null {
    const bot = resolveBot(req, res);
    if (!bot) return null;
    const provider = bot.getProviderFor("jellyfin") as JellyfinCapable;
    if (!provider.configure || !provider.testConnection) {
      res.status(501).json({ error: "Jellyfin provider not available" });
      return null;
    }
    return { bot, provider };
  }

  /** The bot's stored jellyfin credentials (for masked-field fallbacks). */
  function storedJellyfinCredentials(botId: string): Partial<JellyfinConfig> {
    try {
      return JSON.parse(cookieStore.load(botId, "jellyfin") || "{}") as Partial<JellyfinConfig>;
    } catch {
      return {};
    }
  }

  function jellyfinCandidateFrom(
    body: Record<string, unknown>,
    stored: Partial<JellyfinConfig>,
  ): JellyfinConfig {
    const str = (v: unknown, fallback: string) =>
      typeof v === "string" && v.trim() !== "" ? v.trim() : fallback;
    return {
      serverUrl: str(body.serverUrl, stored.serverUrl ?? ""),
      authMode:
        body.authMode === "apikey" || body.authMode === "userpass"
          ? body.authMode
          : stored.authMode ?? "userpass",
      username: str(body.username, stored.username ?? ""),
      password: str(body.password, stored.password ?? ""),
      apiKey: str(body.apiKey, stored.apiKey ?? ""),
      userId: str(body.userId, stored.userId ?? ""),
    };
  }

  // Round-trips /System/Info so Settings can verify form values BEFORE saving.
  // Empty/missing credential fields fall back to the bot's stored credentials,
  // so a masked (not re-entered) password still tests the live setup.
  router.post("/jellyfin/test", requirePermission("platform.auth"), async (req, res) => {
    const target = jellyfinForBot(req, res);
    if (!target) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const stored = storedJellyfinCredentials(target.bot.id);
      res.json(await target.provider.testConnection!(jellyfinCandidateFrom(body, stored)));
    } catch (err) {
      logger.error({ err }, "Jellyfin test connection failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Save this bot's Jellyfin credentials: persist to the bot's cookie slot,
  // reconfigure the live provider (configure() drops the cached token only
  // when credential-relevant fields actually changed), and verify.
  router.post("/jellyfin/login", requirePermission("platform.auth"), async (req, res) => {
    const target = jellyfinForBot(req, res);
    if (!target) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const stored = storedJellyfinCredentials(target.bot.id);
      const candidate = jellyfinCandidateFrom(body, stored);
      if (!candidate.serverUrl) {
        res.status(400).json({ error: "serverUrl is required" });
        return;
      }
      botManager.saveJellyfinCredentials(target.bot.id, {
        serverUrl: candidate.serverUrl,
        authMode: candidate.authMode,
        username: candidate.username,
        password: candidate.password,
        apiKey: candidate.apiKey,
      });
      target.provider.configure!(candidate);
      const result = await target.provider.testConnection!(candidate);
      logger.info({ botId: target.bot.id, ok: result.ok }, "Jellyfin connection saved");
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Jellyfin login failed");
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
    // Jellyfin auth uses the per-bot /jellyfin/login route (credential blob),
    // not a manual cookie; falling through would clobber the NetEase entry.
    if (platform === "jellyfin") {
      res
        .status(400)
        .json({ error: "Jellyfin 通过 /api/auth/jellyfin/login 配置连接，不支持手动 Cookie" });
      return;
    }
    const bot = resolveBot(req, res);
    if (!bot) return;
    const provider = providerFor(bot, platform);
    provider.setCookie(cookie);
    cookieStore.save(bot.id, cookiePlatform(platform), cookie);
    res.json({ success: true });
  });

  // Platform logout: drop the bot's saved credential and reset the live
  // provider so its auth status flips to logged-out without a bot restart.
  // Query params (platform, botId) mirror the save path — proxies send
  // DELETE with a query string.
  router.delete("/cookie", requirePermission("platform.auth"), (req, res) => {
    const platform = typeof req.query.platform === "string" ? req.query.platform : undefined;
    if (!platform) {
      res.status(400).json({ error: "platform is required" });
      return;
    }
    if (platform === "youtube" || platform === "local" || platform === "spotify") {
      res.status(400).json({ error: `${platform} 没有可退出的平台登录` });
      return;
    }
    const bot = resolveBot(req, res);
    if (!bot) return;
    try {
      if (platform === "jellyfin") {
        cookieStore.delete(bot.id, "jellyfin");
        const jellyfin = bot.getProviderFor("jellyfin") as MusicProvider & {
          configure?: (cfg: JellyfinConfig) => void;
        };
        // Empty config → isConfigured() false → getAuthStatus loggedIn:false.
        jellyfin.configure?.({
          serverUrl: "",
          authMode: "userpass",
          username: "",
          password: "",
          apiKey: "",
          userId: "",
        });
      } else {
        const plat = cookiePlatform(platform);
        cookieStore.delete(bot.id, plat);
        providerFor(bot, platform).setCookie("");
      }
      logger.info({ platform, botId: bot.id }, "Platform credential cleared");
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
