import express, { Router } from "express";
import type { MusicProvider } from "../../music/provider.js";
import { YouTubeProvider } from "../../music/youtube.js";
import type { Logger } from "../../logger.js";
import type { BotConfig } from "../../data/config.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";
import { authorize } from "../middleware/authorize.js";

export function createMusicRouter(
  neteaseProvider: MusicProvider,
  qqProvider: MusicProvider,
  bilibiliProvider: MusicProvider,
  logger: Logger,
  localProvider?: MusicProvider,
  config?: BotConfig,
  kugouProvider?: MusicProvider
): Router {
  const router = Router();
  const youtubeProvider: MusicProvider = new YouTubeProvider();

  function isLocalAudioEnabled(): boolean {
    return config?.localAudioEnabled !== false;
  }

  function getProvider(platform?: string): MusicProvider {
    if (platform === "bilibili") return bilibiliProvider;
    if (platform === "youtube") return youtubeProvider;
    if (platform === "local" && localProvider) return localProvider;
    if (platform === "kugou" && kugouProvider) return kugouProvider;
    return platform === "qq" ? qqProvider : neteaseProvider;
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
        if (!localProvider) {
          res.status(501).json({ error: "Local upload is not configured" });
          return;
        }
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
      const provider = getProvider(platform as string);
      const result = await provider.search(
        q as string,
        parseInt(limit as string) || 20
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
      const parsedLimit = parseInt(limit as string) || 20;
      const [neteaseResult, qqResult, bilibiliResult, localResult, kugouResult] = await Promise.allSettled([
        neteaseProvider.search(q as string, parsedLimit),
        qqProvider.search(q as string, parsedLimit),
        bilibiliProvider.search(q as string, parsedLimit),
        localProvider && isLocalAudioEnabled() ? localProvider.search(q as string, parsedLimit) : Promise.resolve({ songs: [], albums: [], playlists: [] }),
        kugouProvider ? kugouProvider.search(q as string, parsedLimit) : Promise.resolve({ songs: [], albums: [], playlists: [] }),
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
      const provider = getProvider(req.query.platform as string);
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
      const provider = getProvider(req.query.platform as string);
      const songs = await provider.getPlaylistSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/playlists", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const playlists = await provider.getRecommendPlaylists();
      res.json({ playlists });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/album/:id", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const songs = await provider.getAlbumSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/lyrics/:id", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const lyrics = await provider.getLyrics(req.params.id);
      res.json({ lyrics });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/songs", requireNotGuest, async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
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
      const provider = getProvider(req.query.platform as string);
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
      const provider = getProvider(req.query.platform as string);
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
      const provider = getProvider(req.query.platform as string);
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
      const provider = bilibiliProvider as any;
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

  // Get current quality
  router.get("/quality", requireNotGuest, (_req, res) => {
    res.json({
      netease: neteaseProvider.getQuality(),
      qq: qqProvider.getQuality(),
      bilibili: bilibiliProvider.getQuality(),
      local: localProvider?.getQuality() ?? "original",
      kugou: kugouProvider?.getQuality() ?? "128",
    });
  });

  // Set quality
  router.post("/quality", requirePermission("quality"), (req, res) => {
    const { quality, platform } = req.body;
    if (!quality) {
      res.status(400).json({ error: "quality is required" });
      return;
    }
    if (!platform || platform === "netease") {
      neteaseProvider.setQuality(quality);
    }
    if (!platform || platform === "qq") {
      qqProvider.setQuality(quality);
    }
    if (!platform || platform === "bilibili") {
      bilibiliProvider.setQuality(quality);
    }
    if ((!platform || platform === "kugou") && kugouProvider) {
      kugouProvider.setQuality(quality);
    }
    logger.info({ quality, platform }, "Audio quality changed");
    res.json({ success: true, quality });
  });

  return router;
}
