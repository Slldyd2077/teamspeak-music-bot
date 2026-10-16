import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { generateIdentity, identityFromString } from "@honeybbq/teamspeak-client";
import type { BotDatabase, BotInstance as SavedBot } from "../data/database.js";
import type { ProviderFactory } from "./provider-factory.js";
import type { CookieStore } from "../music/auth.js";
import type { AvatarStore } from "../data/avatars.js";
import type { PermissionStore } from "../data/permissions.js";
import type { Logger } from "../logger.js";
import { getDefaultConfig } from "../data/config.js";

const probe = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
vi.mock("./instance.js", () => ({
  BotInstance: class extends EventEmitter {
    id: string;
    name: string;
    identity: string;
    constructor(options: { id: string; name: string; tsOptions: { identity?: string } }) {
      super();
      this.id = options.id;
      this.name = options.name;
      this.identity = options.tsOptions.identity || generateIdentity(8).toString();
    }
    getIdentityExport() { return this.identity; }
    connect() { return probe.connect(this); }
    disconnect() { probe.disconnect(); }
  },
}));
import { BotManager } from "./manager.js";

function fixture(initial?: SavedBot) {
  const rows = new Map<string, SavedBot>(initial ? [[initial.id, initial]] : []);
  const database = {
    getBotInstances: () => [...rows.values()],
    saveBotInstance: (saved: SavedBot) => rows.set(saved.id, { ...saved }),
    getMusicQuality: () => ({}),
  } as unknown as BotDatabase;
  const provider = () => ({ platform: "test", setPersist() {} });
  const factory = {
    createNetease: provider, createQQ: provider, createBiliBili: provider,
    createKugou: provider, createJellyfin: provider,
    localProvider: provider(), youtubeProvider: provider(), spotifyProvider: provider(),
  } as unknown as ProviderFactory;
  const logger = { info() {}, warn() {}, error() {} } as unknown as Logger;
  const manager = new BotManager(
    factory, { load: () => "" } as unknown as CookieStore, database,
    getDefaultConfig(), logger, {} as AvatarStore, {} as PermissionStore, "unused.json",
  );
  return { manager, rows };
}

const params = { name: "voice", nickname: "voice", serverAddress: "ts.test", serverPort: 9987 };
const legacy: SavedBot = {
  ...params, id: "legacy", defaultChannel: "", channelId: "", channelPassword: "",
  serverPassword: "", serverProtocol: "", ts6ApiKey: "", autoStart: false,
};

beforeEach(() => { probe.connect.mockReset(); probe.disconnect.mockReset(); });

describe("voice identity persistence", () => {
  it("creates independent personal login providers without borrowing a bot cookie", () => {
    const { manager } = fixture();
    const first = manager.createPersonalNeteaseProvider();
    const second = manager.createPersonalNeteaseProvider();
    expect(first).not.toBe(second);
    expect(manager.getAllBots()).toEqual([]);
  });
  it("stores a new identity before any connection attempt", async () => {
    const { manager, rows } = fixture();
    const bot = await manager.createBot(params);
    expect(rows.get(bot.id)?.identity).toBe(bot.getIdentityExport());
    expect(identityFromString(rows.get(bot.id)!.identity!).securityLevel()).toBeGreaterThanOrEqual(8);
    expect(rows.get(bot.id)?.autoStart).toBe(false);
    expect(probe.connect).not.toHaveBeenCalled();
  });

  it("repairs a legacy NULL identity and reuses it after rejected handshakes", async () => {
    const { manager, rows } = fixture(legacy);
    await manager.loadSavedBots();
    const identity = rows.get("legacy")?.identity;
    expect(identity).toBeTruthy();
    probe.connect.mockImplementation(async (bot: { getIdentityExport(): string }) => {
      expect(bot.getIdentityExport()).toBe(identity);
      expect(rows.get("legacy")?.identity).toBe(identity);
      throw new Error("handshake rejected");
    });
    await expect(manager.startBot("legacy")).rejects.toThrow("handshake rejected");
    await expect(manager.startBot("legacy")).rejects.toThrow("handshake rejected");
    expect(rows.get("legacy")?.identity).toBe(identity);
    expect(rows.get("legacy")?.autoStart).toBe(false);
    expect(probe.connect).toHaveBeenCalledTimes(2);
  });

  it("keeps autoStart and the current identity after successful connection", async () => {
    const { manager, rows } = fixture(legacy);
    await manager.loadSavedBots();
    probe.connect.mockResolvedValue(undefined);
    await manager.startBot("legacy");
    expect(rows.get("legacy")?.identity).toBe(manager.getBot("legacy")?.getIdentityExport());
    expect(rows.get("legacy")?.autoStart).toBe(true);
  });

  it("stores a legacy identity before an automatic connection can fail", async () => {
    const { manager, rows } = fixture({ ...legacy, autoStart: true });
    probe.connect.mockImplementation(async (bot: { getIdentityExport(): string }) => {
      expect(rows.get("legacy")?.identity).toBe(bot.getIdentityExport());
      throw new Error("handshake rejected");
    });
    await manager.loadSavedBots();
    expect(rows.get("legacy")?.identity).toBeTruthy();
    expect(rows.get("legacy")?.autoStart).toBe(true);
  });
});
