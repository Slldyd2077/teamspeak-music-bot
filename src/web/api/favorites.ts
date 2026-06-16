import { Router } from "express";
import type { BotDatabase } from "../../data/database.js";
import type { Logger } from "../../logger.js";

export function createFavoritesRouter(database: BotDatabase, logger: Logger): Router {
  const router = Router();

  // GET /api/favorites — 获取当前用户的所有收藏
  router.get("/", (req, res) => {
    const userId = req.user!.id;
    const favorites = database.getFavorites(userId);
    res.json({ favorites });
  });

  // POST /api/favorites — 添加收藏
  router.post("/", (req, res) => {
    const userId = req.user!.id;
    const { platform, playlistId, name, coverUrl, songCount } = req.body ?? {};
    if (!platform || !playlistId || !name) {
      res.status(400).json({ error: "platform, playlistId, name are required" });
      return;
    }
    try {
      database.addFavorite(userId, {
        platform,
        playlistId,
        name,
        coverUrl: coverUrl ?? "",
        songCount: songCount ?? 0,
      });
      logger.info({ userId, platform, playlistId, name }, "Playlist favorited");
      res.json({ success: true });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        res.status(409).json({ error: "already favorited" });
        return;
      }
      logger.error({ err }, "Failed to add favorite");
      res.status(500).json({ error: "internal error" });
    }
  });

  // DELETE /api/favorites/:id — 取消收藏（只允许删除自己的）
  router.delete("/:id", (req, res) => {
    const userId = req.user!.id;
    const favId = parseInt(req.params.id, 10);
    if (isNaN(favId)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const favorites = database.getFavorites(userId);
    const fav = favorites.find((f) => f.id === favId);
    if (!fav) {
      res.status(404).json({ error: "favorite not found" });
      return;
    }
    database.removeFavorite(userId, fav.playlistId, fav.platform);
    logger.info({ userId, playlistId: fav.playlistId, platform: fav.platform }, "Playlist unfavorited");
    res.json({ success: true });
  });

  // GET /api/favorites/check?platform=netease&playlistId=xxx — 检查是否已收藏
  router.get("/check", (req, res) => {
    const userId = req.user!.id;
    const { platform, playlistId } = req.query;
    if (typeof platform !== "string" || typeof playlistId !== "string") {
      res.status(400).json({ error: "platform and playlistId required" });
      return;
    }
    const favorited = database.isFavorited(userId, playlistId, platform);
    res.json({ favorited });
  });

  return router;
}