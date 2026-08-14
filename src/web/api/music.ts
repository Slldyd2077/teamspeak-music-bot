import express, { Router, type Request, type Response } from "express";
import type { MusicProvider, Song, Album } from "../../music/provider.js";
import type { BotManager } from "../../bot/manager.js";
import type { BotInstance } from "../../bot/instance.js";
import type { Logger } from "../../logger.js";
import { isProviderEnabled, defaultPlatform, type BotConfig } from "../../data/config.js";
import type { BotDatabase } from "../../data/database.js";
import {
  isQualityPlatform,
  qualityRequiresVip,
  validateQuality,
  type QualityPlatform,
} from "../../music/quality.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";
import { authorize } from "../middleware/authorize.js";

type Platform =
  | "netease"
  | "qq"
  | "bilibili"
  | "youtube"
  | "local"
  | "kugou"
  | "spotify"
  | "jellyfin";

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
  database?: BotDatabase,
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

  /**
   * Provider gating for user-supplied platform params. No platform → the
   * configured default (see defaultPlatform(); netease in the default config).
   * A disabled platform gets a friendly 400 and null back — the handler must
   * return immediately. Without a config (unit-test routers), everything
   * stays enabled.
   */
  function resolveProvider(req: Request, res: Response, platform?: unknown): MusicProvider | null {
    const bot = resolveBot(req, res);
    if (!bot) return null;
    const requested = typeof platform === "string" && platform ? platform : undefined;
    const target = requested ?? (config ? defaultPlatform(config) : "netease");
    if (config && !isProviderEnabled(config, target)) {
      res.status(400).json({ error: `音源未启用：${target} (provider disabled)` });
      return null;
    }
    return providerFor(bot, target);
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
      const { q, platform, limit, offset } = req.query;
      if (!q) {
        res.status(400).json({ error: "q (query) is required" });
        return;
      }
      if (platform === "local" && !isLocalAudioEnabled()) {
        res.json({ songs: [], playlists: [], albums: [] });
        return;
      }
      const provider = resolveProvider(req, res, platform);
      if (!provider) return;
      // Server-side pagination: offset lets the web load past the first page.
      // Clamp to >= 0 so a bad/negative value falls back to the first page.
      const parsedOffset = Math.max(0, parseInt(offset as string) || 0);
      const result = await provider.search(
        q as string,
        parseInt(limit as string) || 20,
        parsedOffset
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
      // Spotify is intentionally EXCLUDED from unified /search/all in Stage 1:
      // its tracks are metadata-only until the librespot audio backend is
      // attached; Spotify search remains available from its own tab via
      // /search?platform=spotify. Provider gating (#enabledProviders): disabled
      // sources are skipped, not searched. Jellyfin (an opt-in source) leads
      // the merged results when enabled — a self-hosted library match is
      // almost always the wanted one.
      const enabled = (p: string) => !config || isProviderEnabled(config, p);
      const none = { songs: [], albums: [], playlists: [] };
      const [jellyfinResult, neteaseResult, qqResult, bilibiliResult, localResult, kugouResult] = await Promise.allSettled([
        enabled("jellyfin") ? bot.getProviderFor("jellyfin").search(q as string, parsedLimit) : Promise.resolve(none),
        enabled("netease") ? bot.getProviderFor("netease").search(q as string, parsedLimit) : Promise.resolve(none),
        enabled("qq") ? bot.getProviderFor("qq").search(q as string, parsedLimit) : Promise.resolve(none),
        enabled("bilibili") ? bot.getProviderFor("bilibili").search(q as string, parsedLimit) : Promise.resolve(none),
        isLocalAudioEnabled() ? bot.getProviderFor("local").search(q as string, parsedLimit) : Promise.resolve(none),
        enabled("kugou") ? bot.getProviderFor("kugou").search(q as string, parsedLimit) : Promise.resolve(none),
      ]);

      const songs = [
        ...(jellyfinResult.status === "fulfilled" ? jellyfinResult.value.songs : []),
        ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.songs : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.songs : []),
        ...(bilibiliResult.status === "fulfilled" ? bilibiliResult.value.songs : []),
        ...(localResult.status === "fulfilled" ? localResult.value.songs : []),
        ...(kugouResult.status === "fulfilled" ? kugouResult.value.songs : []),
      ];
      const albums = [
        ...(jellyfinResult.status === "fulfilled" ? jellyfinResult.value.albums : []),
        ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.albums : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.albums : []),
      ];
      const playlists = [
        ...(jellyfinResult.status === "fulfilled" ? jellyfinResult.value.playlists : []),
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
      const provider = resolveProvider(req, res, req.query.platform);
      if (!provider) return;
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
      const provider = resolveProvider(req, res, req.query.platform);
      if (!provider) return;
      const songs = await provider.getPlaylistSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/playlists", async (req, res) => {
    try {
      const provider = resolveProvider(req, res, req.query.platform);
      if (!provider) return;
      const playlists = await provider.getRecommendPlaylists();
      res.json({ playlists });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/album/:id", async (req, res) => {
    try {
      const provider = resolveProvider(req, res, req.query.platform);
      if (!provider) return;
      const songs = await provider.getAlbumSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Resolve a song's direct audio URL (SongUrlResult) without playing it on the
  // bot. External consumers (e.g. S-Live vtuber BGM) fetch the stream themselves;
  // the TS-channel playback path is untouched. Auth/CSRF come from the /api
  // middleware chain like every other route; local-audio gating mirrors /song/:id.
  router.get("/url/:id", async (req, res) => {
    try {
      if (req.query.platform === "local" && !isLocalAudioEnabled()) {
        res.status(403).json({ error: "本地音频播放已关闭" });
        return;
      }
      const provider = resolveProvider(req, res, req.query.platform);
      if (!provider) return;
      const result = await provider.getSongUrl(
        req.params.id,
        typeof req.query.quality === "string" ? req.query.quality : undefined,
      );
      if (!result || !result.url) {
        res.status(404).json({ error: "Song URL not available" });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/lyrics/:id", async (req, res) => {
    try {
      const provider = resolveProvider(req, res, req.query.platform);
      if (!provider) return;
      const lyrics = await provider.getLyrics(req.params.id);
      res.json({ lyrics });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/songs", requireNotGuest, async (req, res) => {
    try {
      const provider = resolveProvider(req, res, req.query.platform);
      if (!provider) return;
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
      const provider = resolveProvider(req, res, req.query.platform);
      if (!provider) return;
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
      const provider = resolveProvider(req, res, req.query.platform);
      if (!provider) return;
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
      const provider = resolveProvider(req, res, req.query.platform);
      if (!provider) return;
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

  // Enabled sources + default platform, for the web UI (source tabs, default
  // search/playback source). Without a config (unit-test routers) everything
  // reports enabled with the legacy netease default.
  router.get("/providers", (_req, res) => {
    const ALL_PLATFORMS = [
      "jellyfin",
      "netease",
      "qq",
      "bilibili",
      "youtube",
      "kugou",
      "spotify",
      "local",
    ];
    res.json({
      enabled: config ? ALL_PLATFORMS.filter((p) => isProviderEnabled(config, p)) : ALL_PLATFORMS,
      default: config ? defaultPlatform(config) : "netease",
    });
  });

  // ─── Jellyfin home-page data (per-bot) ──────────────────────────────────
  // The concrete JellyfinProvider surface these endpoints consume; the router
  // only knows the MusicProvider interface, so narrow structurally (same
  // pattern as localProvider.uploadAudio above).
  type JellyfinHomeProvider = MusicProvider & {
    getLatestAlbums?: (limit?: number) => Promise<Album[]>;
    getMostPlayed?: (limit?: number) => Promise<Song[]>;
    getFavoriteSongs?: (limit?: number) => Promise<Song[]>;
    getGenres?: (limit?: number) => Promise<{ id: string; name: string }[]>;
    getGenreSongs?: (genreId: string, limit?: number) => Promise<Song[]>;
  };

  /** Resolve the bot's jellyfin provider; 400 when the source is disabled. */
  function jellyfinForBot(req: Request, res: Response): JellyfinHomeProvider | null {
    const bot = resolveBot(req, res);
    if (!bot) return null;
    if (config && !isProviderEnabled(config, "jellyfin")) {
      res.status(400).json({ error: "音源未启用：jellyfin (provider disabled)" });
      return null;
    }
    return bot.getProviderFor("jellyfin") as JellyfinHomeProvider;
  }

  router.get("/jellyfin/latest-albums", async (req, res) => {
    try {
      const p = jellyfinForBot(req, res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 12;
      res.json({ albums: (await p.getLatestAlbums?.(limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin latest albums failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/jellyfin/most-played", async (req, res) => {
    try {
      const p = jellyfinForBot(req, res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 12;
      res.json({ songs: (await p.getMostPlayed?.(limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin most played failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Favorites are account-level data — guests don't get them (matches the
  // requireNotGuest gate on /user/playlists).
  router.get("/jellyfin/favorites", requireNotGuest, async (req, res) => {
    try {
      const p = jellyfinForBot(req, res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 100;
      res.json({ songs: (await p.getFavoriteSongs?.(limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin favorites failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/jellyfin/genres", async (req, res) => {
    try {
      const p = jellyfinForBot(req, res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 30;
      res.json({ genres: (await p.getGenres?.(limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin genres failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/jellyfin/genre/:id/songs", async (req, res) => {
    try {
      const p = jellyfinForBot(req, res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 100;
      res.json({ songs: (await p.getGenreSongs?.(req.params.id, limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin genre songs failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get current quality (per-bot, all platforms)
  router.get("/quality", requireNotGuest, (req, res) => {
    const bot = resolveBot(req, res);
    if (!bot) return;
    res.json({
      netease: bot.getProviderFor("netease").getQuality(),
      qq: bot.getProviderFor("qq").getQuality(),
      bilibili: bot.getProviderFor("bilibili").getQuality(),
      local: bot.getProviderFor("local").getQuality(),
      kugou: bot.getProviderFor("kugou").getQuality(),
      spotify: bot.getProviderFor("spotify").getQuality(),
      jellyfin: bot.getProviderFor("jellyfin").getQuality(),
    });
  });

  // Set quality (per-bot, per-platform; persisted in the bot_music_quality table)
  router.post("/quality", requirePermission("quality"), async (req, res) => {
    const { quality, platform } = req.body;
    if (!quality) {
      res.status(400).json({ error: "quality is required" });
      return;
    }
    const bot = resolveBot(req, res);
    if (!bot) return;
    if (!isQualityPlatform(platform)) {
      res.status(400).json({ error: "supported platform is required" });
      return;
    }
    const normalized = validateQuality(platform, quality);
    if (!normalized) {
      res.status(400).json({ error: `unsupported quality for ${platform}` });
      return;
    }
    const provider = bot.getProviderFor(platform);
    if (qualityRequiresVip(platform, normalized)) {
      const status = await provider.getAuthStatus();
      if (!status.loggedIn || status.vip !== true) {
        res.status(403).json({ error: "该音质需要已验证且有效的 VIP 会员" });
        return;
      }
    }
    provider.setQuality(normalized);
    database?.saveMusicQuality(bot.id, platform as QualityPlatform, normalized);
    logger.info({ quality: normalized, platform, botId: bot.id }, "Audio quality changed");
    res.json({ success: true, quality: normalized, platform });
  });

  return router;
}
