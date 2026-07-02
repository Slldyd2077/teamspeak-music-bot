import { Router } from "express";
import type { BotManager } from "../../bot/manager.js";
import type { BotConfig, GuestModeConfig, SpotifyConfig } from "../../data/config.js";
import { saveConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";
import type { BotDatabase } from "../../data/database.js";
import type { AvatarStore } from "../../data/avatars.js";
import { requirePermission, requireBotAccess } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";
import { GUEST_PERMISSION_FLAGS } from "../../data/permissions.js";

export function createBotRouter(
  botManager: BotManager,
  config: BotConfig,
  configPath: string,
  logger: Logger,
  botDb: BotDatabase,
  avatarStore: AvatarStore,
  onGuestPolicyChanged?: (cfg: GuestModeConfig) => void,
): Router {
  const router = Router();

  // Masked spotify view shared by the GET response and the POST echo. The raw
  // clientSecret is write-only and NEVER serialized — only whether one is stored.
  const maskedSpotify = () => ({
    enabled: config.spotify.enabled,
    backend: config.spotify.backend,
    clientId: config.spotify.clientId,
    deviceName: config.spotify.deviceName,
    bitrate: config.spotify.bitrate,
    hasClientSecret: config.spotify.clientSecret.length > 0,
  });

  router.get("/", (req, res) => {
    const all = botManager.getAllBots().map((b) => b.getStatus());
    const u = req.user!;
    const bots =
      u.role === "admin" || u.bots === "all"
        ? all
        : all.filter((b) => u.bots instanceof Set && u.bots.has(b.id));
    res.json({ bots });
  });

  // GET /api/bot/settings — 读取全局 bot 行为设置
  // NOTE: must be registered before "/:id" so it isn't shadowed by the param route.
  router.get("/settings", requireNotGuest, (_req, res) => {
    res.json({
      idleTimeoutMinutes: config.idleTimeoutMinutes ?? 0,
      autoPauseOnEmpty: config.autoPauseOnEmpty,
      localAudioEnabled: config.localAudioEnabled,
      adminGroups: config.adminGroups ?? [],
      guestMode: config.guestMode,
      spotify: maskedSpotify(),
    });
  });

  // POST /api/bot/settings — 保存全局 bot 行为设置 (gated: changing global bot
  // behavior is a bot.manage operation, consistent with PR #80's permission model)
  router.post("/settings", requirePermission("bot.manage"), (req, res) => {
    const { idleTimeoutMinutes, autoPauseOnEmpty, localAudioEnabled, guestMode, adminGroups } = req.body;

    const hasIdle = idleTimeoutMinutes !== undefined;
    if (hasIdle && (typeof idleTimeoutMinutes !== "number" || idleTimeoutMinutes < 0)) {
      res.status(400).json({ error: "idleTimeoutMinutes must be a non-negative number" });
      return;
    }

    const hasAutoPause = typeof autoPauseOnEmpty === "boolean";
    const hasLocalAudioEnabled = typeof localAudioEnabled === "boolean";

    if (hasIdle) config.idleTimeoutMinutes = idleTimeoutMinutes;
    if (hasAutoPause) config.autoPauseOnEmpty = autoPauseOnEmpty;
    if (hasLocalAudioEnabled) config.localAudioEnabled = localAudioEnabled;

    const hasGuestMode = guestMode !== undefined && guestMode !== null && typeof guestMode === "object";
    if (hasGuestMode) {
      const gm = config.guestMode;
      if (typeof guestMode.enabled === "boolean") gm.enabled = guestMode.enabled;
      if (guestMode.bots === "all") {
        gm.bots = "all";
      } else if (Array.isArray(guestMode.bots)) {
        gm.bots = guestMode.bots.filter((id: unknown): id is string => typeof id === "string");
      }
      if (guestMode.permissions && typeof guestMode.permissions === "object") {
        for (const f of GUEST_PERMISSION_FLAGS) {
          if (typeof guestMode.permissions[f] === "boolean") {
            gm.permissions[f] = guestMode.permissions[f];
          }
        }
      }
    }

    if (Array.isArray(adminGroups)) {
      config.adminGroups = adminGroups.filter(
        (g: unknown): g is number =>
          typeof g === "number" && Number.isInteger(g) && g >= 0,
      );
    }

    // Partial-merge the spotify block (mirrors config.ts validation). Invalid
    // sub-fields are ignored rather than 400-ing the whole request. Omitting
    // `spotify` entirely leaves config.spotify untouched.
    const VALID_BACKENDS = ["auto", "go-librespot", "librespot"] as const;
    const VALID_BITRATES = [96, 160, 320];
    const sp = req.body?.spotify;
    if (sp && typeof sp === "object") {
      const t = config.spotify;
      if (typeof sp.enabled === "boolean") t.enabled = sp.enabled;
      if (typeof sp.backend === "string" && (VALID_BACKENDS as readonly string[]).includes(sp.backend)) {
        t.backend = sp.backend as SpotifyConfig["backend"];
      }
      if (typeof sp.clientId === "string") t.clientId = sp.clientId;
      // Secret is write-only + set-on-non-empty so a blank field never wipes it.
      if (typeof sp.clientSecret === "string" && sp.clientSecret.length > 0) {
        t.clientSecret = sp.clientSecret;
      }
      if (typeof sp.deviceName === "string" && sp.deviceName.trim().length > 0) {
        t.deviceName = sp.deviceName.trim();
      }
      if (typeof sp.bitrate === "number" && VALID_BITRATES.includes(sp.bitrate)) {
        t.bitrate = sp.bitrate;
      }
    }

    saveConfig(configPath, config);

    // Guest-mode changed: tear down / re-scope in-flight guest WS sockets so a
    // disabled or narrowed scope takes effect immediately (matches requireAuth's
    // "disabling immediately invalidates in-flight guest sessions" invariant).
    if (hasGuestMode) {
      onGuestPolicyChanged?.(config.guestMode);
    }

    // 通知所有 bot 实例更新
    for (const bot of botManager.getAllBots()) {
      if (hasIdle) bot.updateIdleTimeout(config.idleTimeoutMinutes);
      if (hasAutoPause) bot.updateAutoPause(config.autoPauseOnEmpty);
    }

    res.json({
      idleTimeoutMinutes: config.idleTimeoutMinutes ?? 0,
      autoPauseOnEmpty: config.autoPauseOnEmpty,
      localAudioEnabled: config.localAudioEnabled,
      adminGroups: config.adminGroups ?? [],
      guestMode: config.guestMode,
      spotify: maskedSpotify(),
    });
  });

  router.get("/:id", requireBotAccess("id"), (req, res) => {
    const bot = botManager.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    res.json(bot.getStatus());
  });

  // Get saved config for a bot
  router.get("/:id/config", requirePermission("bot.manage"), requireBotAccess("id"), (req, res) => {
    const saved = botManager.getBotConfig(req.params.id);
    if (!saved) {
      res.status(404).json({ error: "Bot config not found" });
      return;
    }
    // Never expose the TS identity / API key to the client; the edit form only
    // consumes channel/server passwords.
    const { ts6ApiKey: _ts6ApiKey, identity: _identity, ...safe } = saved as unknown as Record<string, unknown>;
    res.json(safe);
  });

  router.get("/:id/avatar", requirePermission("bot.manage"), requireBotAccess("id"), (req, res) => {
    const path = botDb.getCustomAvatarPath(req.params.id);
    if (!path) {
      res.status(404).end();
      return;
    }
    const buf = avatarStore.read(path);
    if (!buf) {
      res.status(404).end();
      return;
    }
    const ext = path.split(".").pop() ?? "";
    const mime = ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : "image/jpeg";
    res.set("Content-Type", mime);
    res.set("Cache-Control", "no-cache");
    res.send(buf);
  });

  router.put("/:id/avatar", requirePermission("bot.manage"), requireBotAccess("id"), (req, res) => {
    const exists =
      botManager.getBot(req.params.id) ||
      botDb.getBotInstances().some((b) => b.id === req.params.id);
    if (!exists) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    const { dataUrl } = req.body as { dataUrl?: string };
    if (typeof dataUrl !== "string") {
      res.status(400).json({ error: "dataUrl required" });
      return;
    }
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
    if (!m) {
      res.status(400).json({ error: "dataUrl must be image/png|jpeg|webp base64" });
      return;
    }
    const mime = m[1] as string;
    const buf = Buffer.from(m[2] ?? "", "base64");
    if (buf.length === 0) {
      res.status(400).json({ error: "empty image" });
      return;
    }
    if (buf.length > 200 * 1024) {
      res.status(413).json({ error: "avatar exceeds 200KB limit" });
      return;
    }
    const rel = avatarStore.write(req.params.id, mime, buf);
    botDb.setCustomAvatarPath(req.params.id, rel);
    botManager.getBot(req.params.id)?.getProfileManager().setCustomAvatar(buf);
    res.json({ path: rel });
  });

  router.delete("/:id/avatar", requirePermission("bot.manage"), requireBotAccess("id"), (req, res) => {
    const path = botDb.getCustomAvatarPath(req.params.id);
    if (path) avatarStore.remove(path);
    botDb.setCustomAvatarPath(req.params.id, null);
    botManager.getBot(req.params.id)?.getProfileManager().setCustomAvatar(null);
    res.status(204).end();
  });

  router.post("/", requirePermission("bot.manage"), async (req, res) => {
    try {
      const {
        name,
        serverAddress,
        serverPort,
        nickname,
        defaultChannel,
        channelId,
        channelPassword,
        serverPassword,
        autoStart,
      } = req.body;
      if (!name || !serverAddress || !nickname) {
        res
          .status(400)
          .json({ error: "name, serverAddress, and nickname are required" });
        return;
      }
      const bot = await botManager.createBot({
        name,
        serverAddress,
        serverPort: serverPort ?? 9987,
        nickname,
        defaultChannel,
        channelId,
        channelPassword,
        serverPassword,
        autoStart: autoStart ?? false,
      });
      res.status(201).json(bot.getStatus());
    } catch (err) {
      logger.error({ err }, "Failed to create bot");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Update bot config (must be stopped first to apply connection changes)
  router.put("/:id", requirePermission("bot.manage"), requireBotAccess("id"), async (req, res) => {
    try {
      const bot = botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: "Bot not found" });
        return;
      }
      const { name, serverAddress, serverPort, nickname, defaultChannel, channelId, channelPassword, serverPassword } = req.body;
      // Update in database
      botManager.updateBot(req.params.id, {
        name, serverAddress, serverPort, nickname, defaultChannel, channelId, channelPassword, serverPassword,
      });
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Failed to update bot");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/:id", requirePermission("bot.manage"), requireBotAccess("id"), async (req, res) => {
    try {
      await botManager.removeBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/start", requirePermission("bot.manage"), requireBotAccess("id"), async (req, res) => {
    try {
      await botManager.startBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/stop", requirePermission("bot.manage"), requireBotAccess("id"), (req, res) => {
    try {
      botManager.stopBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
