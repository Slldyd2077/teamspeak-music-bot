import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
  BotInstance,
  type BotInstanceOptions,
} from "./instance.js";
import type { MusicProvider } from "../music/provider.js";
import { NeteaseProvider } from "../music/netease.js";
import { QQMusicProvider } from "../music/qq.js";
import { BiliBiliProvider } from "../music/bilibili.js";
import { YouTubeProvider } from "../music/youtube.js";
import type { CookieStore, Platform } from "../music/auth.js";
import type { BotDatabase } from "../data/database.js";
import { saveConfig, type BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";

import type { ServerProtocol } from "../ts-protocol/client.js";
import type { AvatarStore } from "../data/avatars.js";
import type { PermissionStore } from "../data/permissions.js";

/** 某 bot 的 provider 集合（per-bot 实例，cookie 各自隔离）。 */
interface ProviderSet {
  netease: MusicProvider;
  qq: MusicProvider;
  bilibili: MusicProvider;
  youtube: MusicProvider;
}

/**
 * Run bot.connect() with a hard deadline. If the handshake hangs (e.g. the
 * server silently drops the connection after initivexpand2), we tear the
 * instance down instead of waiting for the library's 60s idle timeout, so
 * the HTTP /start call returns promptly and the UI doesn't lock up.
 */
async function connectWithTimeout(
  bot: BotInstance,
  ms: number,
  logger: Logger
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`connect timeout after ${ms}ms`)),
      ms
    );
  });
  try {
    await Promise.race([bot.connect(), timeout]);
  } catch (err) {
    logger.warn(
      { err, botId: bot.id },
      "Connect failed or timed out — tearing down instance"
    );
    try {
      bot.disconnect();
    } catch {
      // ignore teardown errors
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface CreateBotParams {
  name: string;
  serverAddress: string;
  serverPort: number;
  queryPort?: number;
  nickname: string;
  defaultChannel?: string;
  channelId?: string;
  channelPassword?: string;
  autoStart?: boolean;
  /** Force TS3 or TS6 protocol; omit or "unknown" for auto-detect. */
  serverProtocol?: ServerProtocol;
  /** API key for TS6 HTTP Query (port 10080/10443). */
  ts6ApiKey?: string;
  /** Password required to join the TS server. */
  serverPassword?: string;
}

export class BotManager extends EventEmitter {
  private bots = new Map<string, BotInstance>();
  /** per-bot provider 池：每个 bot 实例各自的 provider（cookie 隔离） */
  private providers = new Map<string, ProviderSet>();
  private cookieStore: CookieStore;
  private neteaseBaseUrl: string;
  private qqBaseUrl: string;
  private youtubeProvider: MusicProvider;
  private database: BotDatabase;
  private config: BotConfig;
  private logger: Logger;
  private avatarStore: AvatarStore;
  private permissions: PermissionStore;
  private configPath: string;

  constructor(
    cookieStore: CookieStore,
    neteaseBaseUrl: string,
    qqBaseUrl: string,
    database: BotDatabase,
    config: BotConfig,
    logger: Logger,
    avatarStore: AvatarStore,
    permissions: PermissionStore,
    configPath: string
  ) {
    super();
    this.cookieStore = cookieStore;
    this.neteaseBaseUrl = neteaseBaseUrl;
    this.qqBaseUrl = qqBaseUrl;
    this.youtubeProvider = new YouTubeProvider();
    this.database = database;
    this.config = config;
    this.logger = logger;
    this.avatarStore = avatarStore;
    this.permissions = permissions;
    this.configPath = configPath;
  }

  /** 为 bot 创建独立 provider 集合 + 加载该 bot 的平台 cookie。 */
  private createProviders(botId: string): ProviderSet {
    const netease = new NeteaseProvider(this.neteaseBaseUrl);
    const qq = new QQMusicProvider(this.qqBaseUrl);
    const bilibili = new BiliBiliProvider();
    const nc = this.cookieStore.load(botId, "netease"); if (nc) netease.setCookie(nc);
    const qc = this.cookieStore.load(botId, "qq"); if (qc) qq.setCookie(qc);
    const bc = this.cookieStore.load(botId, "bilibili"); if (bc) bilibili.setCookie(bc);
    const set: ProviderSet = { netease, qq, bilibili, youtube: this.youtubeProvider };
    this.providers.set(botId, set);
    return set;
  }

  /** 取 bot 的 provider 集合（不存在则创建）。 */
  private getProviders(botId: string): ProviderSet {
    return this.providers.get(botId) ?? this.createProviders(botId);
  }

  /** web API：取某 bot 某 platform 的 provider（平台登录/我的音乐用）。 */
  getProvider(botId: string, platform: Platform): MusicProvider | undefined {
    const set = this.providers.get(botId);
    if (!set) return undefined;
    if (platform === "qq") return set.qq;
    if (platform === "bilibili") return set.bilibili;
    return set.netease;
  }

  /** web API：平台登录确认后，持久化 cookie 并刷新该 bot 的 provider。 */
  saveBotCookie(botId: string, platform: Platform, cookie: string): void {
    if (!cookie) return;
    this.cookieStore.save(botId, platform, cookie);
    const set = this.providers.get(botId);
    if (!set) return;
    if (platform === "netease") set.netease.setCookie(cookie);
    else if (platform === "qq") set.qq.setCookie(cookie);
    else set.bilibili.setCookie(cookie);
  }

  /** web API：取某 bot 的某平台 cookie（手动设置 cookie 端点用）。 */
  getBotCookie(botId: string, platform: Platform): string {
    return this.cookieStore.load(botId, platform);
  }

  async createBot(params: CreateBotParams): Promise<BotInstance> {
    const id = crypto.randomUUID();
    const providers = this.createProviders(id);

    const bot = new BotInstance({
      id,
      name: params.name,
      tsOptions: {
        host: params.serverAddress,
        port: params.serverPort,
        queryPort: params.queryPort ?? 10011,
        nickname: params.nickname,
        defaultChannel: params.defaultChannel,
        channelId: params.channelId,
        channelPassword: params.channelPassword,
        serverPassword: params.serverPassword,
        serverProtocol: params.serverProtocol,
        ts6ApiKey: params.ts6ApiKey,
      },
      neteaseProvider: providers.netease,
      qqProvider: providers.qq,
      bilibiliProvider: providers.bilibili,
      youtubeProvider: providers.youtube,
      database: this.database,
      config: this.config,
      logger: this.logger,
      avatarStore: this.avatarStore,
    });

    this.bots.set(id, bot);
    this.emit("botInstance", bot);

    this.database.saveBotInstance({
      id,
      name: params.name,
      serverAddress: params.serverAddress,
      serverPort: params.serverPort,
      nickname: params.nickname,
      defaultChannel: params.defaultChannel ?? "",
      channelId: params.channelId ?? "",
      channelPassword: params.channelPassword ?? "",
      autoStart: params.autoStart ?? false,
      serverProtocol: params.serverProtocol ?? "",
      ts6ApiKey: params.ts6ApiKey ?? "",
      serverPassword: params.serverPassword ?? "",
    });

    this.logger.info({ botId: id, name: params.name }, "Bot instance created");
    return bot;
  }

  async removeBot(id: string): Promise<void> {
    const bot = this.bots.get(id);
    if (bot) {
      bot.disconnect();
      this.bots.delete(id);
    }
    this.providers.delete(id);
    this.database.deleteBotInstance(id);
    this.permissions.pruneBot(id);
    // Prune the deleted bot from the guest scope allow-list (mirrors permissions.pruneBot).
    if (Array.isArray(this.config.guestMode.bots) && this.config.guestMode.bots.includes(id)) {
      this.config.guestMode.bots = this.config.guestMode.bots.filter((b) => b !== id);
      saveConfig(this.configPath, this.config);
    }
    this.emit("botInstanceRemoved", id);
    this.logger.info({ botId: id }, "Bot instance removed");
  }

  updateBot(id: string, params: Partial<CreateBotParams>): void {
    const instances = this.database.getBotInstances();
    const existing = instances.find((i) => i.id === id);
    if (!existing) throw new Error(`Bot ${id} not found`);

    this.database.saveBotInstance({
      ...existing,
      name: params.name ?? existing.name,
      serverAddress: params.serverAddress ?? existing.serverAddress,
      serverPort: params.serverPort ?? existing.serverPort,
      nickname: params.nickname ?? existing.nickname,
      defaultChannel: params.defaultChannel ?? existing.defaultChannel,
      channelId: params.channelId ?? existing.channelId,
      channelPassword: params.channelPassword ?? existing.channelPassword,
      serverProtocol: params.serverProtocol ?? existing.serverProtocol,
      ts6ApiKey: params.ts6ApiKey ?? existing.ts6ApiKey,
      serverPassword: params.serverPassword ?? existing.serverPassword,
    });
    // Update in-memory name immediately (other fields need reconnect)
    const bot = this.bots.get(id);
    if (bot && params.name) {
      bot.name = params.name;
    }
    this.logger.info({ botId: id }, "Bot instance config updated (connection changes need restart)");
  }

  getBotConfig(id: string): import("../data/database.js").BotInstance | undefined {
    return this.database.getBotInstances().find((i) => i.id === id);
  }

  getBot(id: string): BotInstance | undefined {
    return this.bots.get(id);
  }

  getAllBots(): BotInstance[] {
    return Array.from(this.bots.values());
  }

  async startBot(id: string): Promise<void> {
    const oldBot = this.bots.get(id);
    if (!oldBot) throw new Error(`Bot ${id} not found`);

    // Always tear down the outgoing instance before creating a replacement.
    // Covers three cases:
    //   1. oldBot is fully connected (manual restart)
    //   2. oldBot is mid-handshake from a prior rapid start (isConnected()
    //      still returns false but the library client is live and will leak
    //      a TS session if we abandon it)
    //   3. oldBot was just created by createBot but never connected — the
    //      disconnect call is a cheap no-op here.
    // Calling disconnect() is idempotent (disconnectEmitted guards event
    // emission), so this is safe in all states.
    oldBot.disconnect();

    // Reload config from database so updated settings (channel, nickname, etc.) take effect
    const saved = this.database.getBotInstances().find((i) => i.id === id);
    if (saved) {
      const providers = this.getProviders(saved.id);
      const proto = saved.serverProtocol as "ts3" | "ts6" | "" | undefined;
      const bot = new BotInstance({
        id: saved.id,
        name: saved.name,
        tsOptions: {
          host: saved.serverAddress,
          port: saved.serverPort,
          queryPort: proto === "ts6" ? 10080 : 10011,
          nickname: saved.nickname,
          // Reuse the stored identity so server groups assigned to this bot
          // survive restarts — without this the TS server sees a new UID
          // each connect and strips all previously granted groups.
          identity: saved.identity || undefined,
          defaultChannel: saved.defaultChannel || undefined,
          channelId: saved.channelId || undefined,
          channelPassword: saved.channelPassword || undefined,
          serverPassword: saved.serverPassword || undefined,
          serverProtocol: proto === "ts3" || proto === "ts6" ? proto : undefined,
          ts6ApiKey: saved.ts6ApiKey || undefined,
        },
        neteaseProvider: providers.netease,
        qqProvider: providers.qq,
        bilibiliProvider: providers.bilibili,
        youtubeProvider: providers.youtube,
        database: this.database,
        config: this.config,
        logger: this.logger,
        avatarStore: this.avatarStore,
      });
      this.bots.set(id, bot);
      this.emit("botInstance", bot);
      await connectWithTimeout(bot, 15_000, this.logger);
      // Mark as autoStart so it reconnects on Docker restart, and persist identity
      this.database.saveBotInstance({ ...saved, autoStart: true });
      this.persistBotIdentity(saved, bot);
    } else {
      await connectWithTimeout(oldBot, 15_000, this.logger);
    }
  }

  stopBot(id: string): void {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    bot.disconnect();

    // Mark as not autoStart so it stays stopped on Docker restart
    const saved = this.database.getBotInstances().find((i) => i.id === id);
    if (saved) {
      this.database.saveBotInstance({ ...saved, autoStart: false });
    }
  }

  async loadSavedBots(): Promise<void> {
    const savedInstances = this.database.getBotInstances();
    for (const saved of savedInstances) {
      const providers = this.getProviders(saved.id);
      const proto = saved.serverProtocol as "ts3" | "ts6" | "" | undefined;
      const bot = new BotInstance({
        id: saved.id,
        name: saved.name,
        tsOptions: {
          host: saved.serverAddress,
          port: saved.serverPort,
          queryPort: proto === "ts6" ? 10080 : 10011,
          nickname: saved.nickname,
          identity: saved.identity || undefined,
          defaultChannel: saved.defaultChannel || undefined,
          channelId: saved.channelId || undefined,
          channelPassword: saved.channelPassword || undefined,
          serverPassword: saved.serverPassword || undefined,
          serverProtocol: proto === "ts3" || proto === "ts6" ? proto : undefined,
          ts6ApiKey: saved.ts6ApiKey || undefined,
        },
        neteaseProvider: providers.netease,
        qqProvider: providers.qq,
        bilibiliProvider: providers.bilibili,
        youtubeProvider: providers.youtube,
        database: this.database,
        config: this.config,
        logger: this.logger,
        avatarStore: this.avatarStore,
      });

      this.bots.set(saved.id, bot);
      this.emit("botInstance", bot);

      // Only auto-connect bots that have autoStart enabled
      if (saved.autoStart) {
        bot.connect().then(() => {
          // Persist identity after successful connection for future restarts
          this.persistBotIdentity(saved, bot);
          this.logger.info(
            { botId: saved.id, name: saved.name },
            "Auto-connected saved bot"
          );
        }).catch((err) => {
          this.logger.error(
            { err, botId: saved.id, name: saved.name },
            "Failed to auto-connect bot (start manually from Settings)"
          );
        });

        // Stagger connections to avoid overwhelming the TS server
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        this.logger.info(
          { botId: saved.id, name: saved.name },
          "Loaded bot (autoStart disabled, not connecting)"
        );
      }
    }

    this.logger.info(
      { count: savedInstances.length },
      "Loaded saved bot instances"
    );
  }

  private persistBotIdentity(saved: import("../data/database.js").BotInstance, bot: BotInstance): void {
    const identity = bot.getIdentityExport();
    if (identity && identity !== saved.identity) {
      this.database.saveBotInstance({ ...saved, identity });
    }
  }

  shutdown(): void {
    for (const bot of this.bots.values()) {
      bot.disconnect();
    }
    this.bots.clear();
    this.providers.clear();
  }
}
