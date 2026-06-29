import { Router } from "express";
import type { MusicProvider } from "../../music/provider.js";
import { NeteaseProvider } from "../../music/netease.js";
import { QQMusicProvider } from "../../music/qq.js";
import { BiliBiliProvider } from "../../music/bilibili.js";
import { YouTubeProvider } from "../../music/youtube.js";
import type { Platform } from "../../music/auth.js";
import type { BotManager } from "../../bot/manager.js";
import type { Logger } from "../../logger.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";

interface ProviderSet {
  netease: MusicProvider;
  qq: MusicProvider;
  bilibili: MusicProvider;
}

export function createMusicRouter(
  botManager: BotManager,
  neteaseBaseUrl: string,
  qqBaseUrl: string,
  logger: Logger
): Router {
  const router = Router();
  const youtubeProvider: MusicProvider = new YouTubeProvider();
  // 默认匿名 provider 集合（无 botId 时用，无 cookie）：搜索等不需登录态的请求
  const defaultSet: ProviderSet = {
    netease: new NeteaseProvider(neteaseBaseUrl),
    qq: new QQMusicProvider(qqBaseUrl),
    bilibili: new BiliBiliProvider(),
  };

  const platOf = (p?: string): Platform =>
    p === "qq" ? "qq" : p === "bilibili" ? "bilibili" : "netease";

  /** 取 bot 的 provider 集合（带该 bot cookie）；无 botId 用默认匿名集合。 */
  function setFor(botId?: string): ProviderSet {
    if (!botId) return defaultSet;
    return {
      netease: botManager.getProvider(botId, "netease") ?? defaultSet.netease,
      qq: botManager.getProvider(botId, "qq") ?? defaultSet.qq,
      bilibili: botManager.getProvider(botId, "bilibili") ?? defaultSet.bilibili,
    };
  }

  function getProvider(platform: string, botId?: string): MusicProvider {
    if (platform === "youtube") return youtubeProvider;
    return setFor(botId)[platOf(platform)];
  }

  router.get("/search", async (req, res) => {
    try {
      const { q, platform, limit } = req.query;
      if (!q) {
        res.status(400).json({ error: "q (query) is required" });
        return;
      }
      const botId = req.query.botId as string | undefined;
      const provider = getProvider(platform as string, botId);
      const result = await provider.search(q as string, parseInt(limit as string) || 20);
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
      const botId = req.query.botId as string | undefined;
      const set = setFor(botId);
      const parsedLimit = parseInt(limit as string) || 20;
      const [neteaseResult, qqResult, bilibiliResult] = await Promise.allSettled([
        set.netease.search(q as string, parsedLimit),
        set.qq.search(q as string, parsedLimit),
        set.bilibili.search(q as string, parsedLimit),
      ]);

      const songs = [
        ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.songs : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.songs : []),
        ...(bilibiliResult.status === "fulfilled" ? bilibiliResult.value.songs : []),
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
      const botId = req.query.botId as string | undefined;
      const provider = getProvider(req.query.platform as string, botId);
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
      const botId = req.query.botId as string | undefined;
      const provider = getProvider(req.query.platform as string, botId);
      const songs = await provider.getPlaylistSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/playlists", async (req, res) => {
    try {
      const botId = req.query.botId as string | undefined;
      const provider = getProvider(req.query.platform as string, botId);
      const playlists = await provider.getRecommendPlaylists();
      res.json({ playlists });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/album/:id", async (req, res) => {
    try {
      const botId = req.query.botId as string | undefined;
      const provider = getProvider(req.query.platform as string, botId);
      const songs = await provider.getAlbumSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/lyrics/:id", async (req, res) => {
    try {
      const botId = req.query.botId as string | undefined;
      const provider = getProvider(req.query.platform as string, botId);
      const lyrics = await provider.getLyrics(req.params.id);
      res.json({ lyrics });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/songs", requireNotGuest, async (req, res) => {
    try {
      const botId = req.query.botId as string | undefined;
      const provider = getProvider(req.query.platform as string, botId);
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
      const botId = req.query.botId as string | undefined;
      const provider = getProvider(req.query.platform as string, botId);
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
      const botId = req.query.botId as string | undefined;
      const provider = getProvider(req.query.platform as string, botId);
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
      const botId = req.query.botId as string | undefined;
      const provider = getProvider(req.query.platform as string, botId);
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

  // B站热门视频（匿名可用）
  router.get("/bilibili/popular", async (req, res) => {
    try {
      const botId = req.query.botId as string | undefined;
      const provider = setFor(botId).bilibili as any;
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

  // 音质（用默认 provider 集合；PowerfulTS 不使用此端点）
  router.get("/quality", requireNotGuest, (_req, res) => {
    res.json({
      netease: defaultSet.netease.getQuality(),
      qq: defaultSet.qq.getQuality(),
      bilibili: defaultSet.bilibili.getQuality(),
    });
  });

  router.post("/quality", requirePermission("quality"), (req, res) => {
    const { quality, platform } = req.body;
    if (!quality) {
      res.status(400).json({ error: "quality is required" });
      return;
    }
    if (!platform || platform === "netease") defaultSet.netease.setQuality(quality);
    if (!platform || platform === "qq") defaultSet.qq.setQuality(quality);
    if (!platform || platform === "bilibili") defaultSet.bilibili.setQuality(quality);
    logger.info({ quality, platform }, "Audio quality changed");
    res.json({ success: true, quality });
  });

  return router;
}
