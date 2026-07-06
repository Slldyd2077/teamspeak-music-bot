import express, { Router } from "express";
import type { Request, Response } from "express";
import type { MusicProvider } from "../../music/provider.js";
import type { BotManager } from "../../bot/manager.js";
import type { BotInstance } from "../../bot/instance.js";
import type { Logger } from "../../logger.js";
import type { BotConfig } from "../../data/config.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";
import { authorize } from "../middleware/authorize.js";

type Platform = "netease" | "qq" | "bilibili" | "youtube" | "local" | "kugou";

/**
 * Per-bot music router. Every platform call is scoped to a bot (which owns its
 * own provider instances + cookies), so search / playlists / recommend / FM /
 * quality are all per-bot. `/local/upload` is the exception: local audio is a
 * shared store (cookie-less), so it uses the shared local provider directly.
 */
export function createMusicRouter(
  botManager: BotManager,
  logger: Logger,
  config?: BotConfig,
): Router {
  const router = Router();

  function isLocalAudioEnabled(): boolean {
    return config?.localAudioEnabled !== false;
  }

  function botIdFrom(req: Request): string | undefined {
    const q = req.query.botId;
    if (typeof q === "string" && q) return q;
    const b = (req.body as { botId?: unknown } | undefined)?.botId;
    return typeof b === "string" && b ? b : undefined;
  }

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

  router.post(
    "/local/upload",
    authorize({ capability: "player.queue", guestFlag: "addToQueue" }),
    (_req, res, next) => {
      if (!isLocalAudioEnabled()) {
        res.status(403).json({ error: "本地音频播放已关闭" });
        return;
      }
      next();
    },
    express.raw({
      type: ["audio/*", "video/webm", "application/octet-stream"],
      limit: "200mb",
    }),
    async (req, res) => {
      try {
        const localProvider = botManager.getLocalProvider();
        const uploadCapable = localProvider as MusicProvider & {
          uploadAudio?: (input: { buffer: Buffer; originalName: string; mimeType?: string }) => Promise<unknown>;
        };
        if (typeof uploadCapable.uploadAudio !== "function") {
          res.status(501).json({ error: "Local upload is not supported" });
          return;
        }
        if (!Buffer.isBuffer(req.body)) {
          res.status(400).json({ error: "raw audio body is required" });
          return;
        }
        const headerName = req.header("x-filename") || req.header("x-file-name") || "audio";
        let originalName = headerName;
        try {
          originalName = decodeURIComponent(headerName);
        } catch {
          // Keep the raw header value if it is not URI encoded.
        }
        const song = await uploadCapable.uploadAudio({
          buffer: req.body,
          originalName,
          mimeType: req.header("content-type") || undefined,
        });
        res.json({ song });
      } catch (err) {
        logger.warn({ err }, "Local audio upload failed");
        res.status(400).json({ error: (err as Error).message });
      }
    },
  );

  router.get("/search", async (req, res) => {
    try {
      const { q, platform, limit } = req.query;
      if (!q) {
        res.status(400).json({ error: "q (query) is required" });
        return;
      }
      if (platform === "local" && !isLocalAudioEnabled()) {
        res.json({ songs: [], playlists: [], albums: [] });
        return;
      }
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, platform as string);
      const result = await provider.search(
        q as string,
        parseInt(limit as string) || 20,
      );
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Search failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/search/all", async (req, res) => {
    try {
      const { q, limit } = req.query;
      if (!q) {
        res.status(400).json({ error: "q (query) is required" });
        return;
      }
      const bot = resolveBot(req, res);
      if (!bot) return;
      const parsedLimit = parseInt(limit as string) || 20;
      const empty = Promise.resolve({ songs: [], albums: [], playlists: [] });
      const [neteaseResult, qqResult, bilibiliResult, localResult, kugouResult] = await Promise.allSettled([
        bot.getProviderFor("netease").search(q as string, parsedLimit),
        bot.getProviderFor("qq").search(q as string, parsedLimit),
        bot.getProviderFor("bilibili").search(q as string, parsedLimit),
        isLocalAudioEnabled() ? bot.getProviderFor("local").search(q as string, parsedLimit) : empty,
        bot.getProviderFor("kugou").search(q as string, parsedLimit),
      ]);

      const songs = [
        ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.songs : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.songs : []),
        ...(bilibiliResult.status === "fulfilled" ? bilibiliResult.value.songs : []),
        ...(localResult.status === "fulfilled" ? localResult.value.songs : []),
        ...(kugouResult.status === "fulfilled" ? kugouResult.value.songs : []),
      ];
      const albums = [
        ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.albums : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.albums : []),
      ];
      const playlists = [
        ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.playlists : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.playlists : []),
      ];

      res.json({ songs, albums, playlists });
    } catch (err) {
      logger.error({ err }, "Unified search failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/song/:id", async (req, res) => {
    try {
      if (req.query.platform === "local" && !isLocalAudioEnabled()) {
        res.status(403).json({ error: "本地音频播放已关闭" });
        return;
      }
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, req.query.platform as string);
      const song = await provider.getSongDetail(req.params.id);
      if (!song) {
        res.status(404).json({ error: "Song not found" });
        return;
      }
      res.json(song);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/playlist/:id", async (req, res) => {
    try {
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, req.query.platform as string);
      const songs = await provider.getPlaylistSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/playlists", async (req, res) => {
    try {
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, req.query.platform as string);
      const playlists = await provider.getRecommendPlaylists();
      res.json({ playlists });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/album/:id", async (req, res) => {
    try {
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, req.query.platform as string);
      const songs = await provider.getAlbumSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/lyrics/:id", async (req, res) => {
    try {
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, req.query.platform as string);
      const lyrics = await provider.getLyrics(req.params.id);
      res.json({ lyrics });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/songs", requireNotGuest, async (req, res) => {
    try {
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, req.query.platform as string);
      if (!provider.getDailyRecommendSongs) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const songs = await provider.getDailyRecommendSongs();
      res.json({ songs });
    } catch (err) {
      logger.error({ err }, "Get daily recommend songs failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/personal/fm", requireNotGuest, async (req, res) => {
    try {
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, req.query.platform as string);
      if (!provider.getPersonalFm) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const songs = await provider.getPersonalFm();
      res.json({ songs });
    } catch (err) {
      logger.error({ err }, "Get personal FM failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/user/playlists", requireNotGuest, async (req, res) => {
    try {
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, req.query.platform as string);
      if (!provider.getUserPlaylists) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const playlists = await provider.getUserPlaylists();
      res.json({ playlists });
    } catch (err) {
      logger.error({ err }, "Get user playlists failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/playlist/:id/detail", async (req, res) => {
    try {
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = providerFor(bot, req.query.platform as string);
      if (!provider.getPlaylistDetail) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const detail = await provider.getPlaylistDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: "Playlist not found" });
        return;
      }
      res.json({ playlist: detail });
    } catch (err) {
      logger.error({ err }, "Get playlist detail failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // B站热门视频
  router.get("/bilibili/popular", async (req, res) => {
    try {
      const bot = resolveBot(req, res);
      if (!bot) return;
      const provider = bot.getProviderFor("bilibili") as MusicProvider & {
        getPopularVideos?: (limit: number) => Promise<unknown[]>;
      };
      if (provider.getPopularVideos) {
        const limit = parseInt(req.query.limit as string) || 20;
        const songs = await provider.getPopularVideos(limit);
        res.json({ songs });
      } else {
        res.json({ songs: [] });
      }
    } catch (err) {
      logger.error({ err }, "Get bilibili popular failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get current quality (per-bot)
  router.get("/quality", requireNotGuest, (req, res) => {
    const bot = resolveBot(req, res);
    if (!bot) return;
    res.json({
      netease: bot.getProviderFor("netease").getQuality(),
      qq: bot.getProviderFor("qq").getQuality(),
      bilibili: bot.getProviderFor("bilibili").getQuality(),
      local: bot.getProviderFor("local").getQuality(),
      kugou: bot.getProviderFor("kugou").getQuality(),
    });
  });

  // Set quality (per-bot)
  router.post("/quality", requirePermission("quality"), (req, res) => {
    const { quality, platform } = req.body;
    if (!quality) {
      res.status(400).json({ error: "quality is required" });
      return;
    }
    const bot = resolveBot(req, res);
    if (!bot) return;
    if (!platform || platform === "netease") {
      bot.getProviderFor("netease").setQuality(quality);
    }
    if (!platform || platform === "qq") {
      bot.getProviderFor("qq").setQuality(quality);
    }
    if (!platform || platform === "bilibili") {
      bot.getProviderFor("bilibili").setQuality(quality);
    }
    if (!platform || platform === "kugou") {
      bot.getProviderFor("kugou").setQuality(quality);
    }
    logger.info({ quality, platform, botId: bot.id }, "Audio quality changed");
    res.json({ success: true, quality });
  });

  return router;
}
