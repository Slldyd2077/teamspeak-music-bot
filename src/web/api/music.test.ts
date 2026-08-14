import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MusicProvider, SearchResult } from "../../music/provider.js";
import { getDefaultConfig, type BotConfig } from "../../data/config.js";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createSessionStore } from "../../data/sessions.js";
import { createPermissionStore } from "../../data/permissions.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";
import { createMusicRouter } from "./music.js";
import type { BotManager } from "../../bot/manager.js";
import type { BotInstance } from "../../bot/instance.js";

const empty: SearchResult = { songs: [], albums: [], playlists: [] };
const BOT_ID = "bot-1";
const logger = pino({ level: "silent" });

function fakeProvider(platform: MusicProvider["platform"]): MusicProvider {
  return {
    platform,
    search: vi.fn().mockResolvedValue(empty),
  } as unknown as MusicProvider;
}

/** BotManager stub that resolves every bot to a bot whose providers come from
 *  the given per-platform map (default: fresh fakeProvider). */
function makeBotManager(
  providers: Partial<Record<string, MusicProvider>> = {},
): BotManager {
  const bot = {
    id: BOT_ID,
    getProviderFor: (p: string) =>
      providers[p] ?? fakeProvider(p as MusicProvider["platform"]),
  } as unknown as BotInstance;
  return {
    getBot: (id: string) => (id === BOT_ID ? bot : undefined),
    getLocalProvider: () => providers.local ?? fakeProvider("local"),
  } as unknown as BotManager;
}

describe("music router GET /search offset pagination (per-bot)", () => {
  let app: express.Express;
  let netease: MusicProvider;

  beforeEach(() => {
    netease = fakeProvider("netease");
    const router = createMusicRouter(makeBotManager({ netease }), logger);
    app = express();
    app.use("/api/music", router);
  });

  it("parses offset and passes it as the 3rd arg to provider.search", async () => {
    const res = await request(app).get(`/api/music/search?q=hello&limit=20&offset=20&botId=${BOT_ID}`);
    expect(res.status).toBe(200);
    expect(netease.search).toHaveBeenCalledWith("hello", 20, 20);
  });

  it("defaults a missing offset to 0", async () => {
    const res = await request(app).get(`/api/music/search?q=hello&limit=20&botId=${BOT_ID}`);
    expect(res.status).toBe(200);
    expect(netease.search).toHaveBeenCalledWith("hello", 20, 0);
  });

  it("clamps a negative offset to 0", async () => {
    const res = await request(app).get(`/api/music/search?q=hello&limit=20&offset=-5&botId=${BOT_ID}`);
    expect(res.status).toBe(200);
    expect(netease.search).toHaveBeenCalledWith("hello", 20, 0);
  });

  it("requires a botId", async () => {
    const res = await request(app).get("/api/music/search?q=hello");
    expect(res.status).toBe(400);
  });
});

describe("music router provider gating (enabledProviders) + jellyfin endpoints", () => {
  function jellyfinFake(): MusicProvider {
    return {
      platform: "jellyfin",
      search: vi.fn().mockResolvedValue(empty),
      getQuality: vi.fn().mockReturnValue("direct"),
      getLatestAlbums: vi
        .fn()
        .mockResolvedValue([{ id: "a1", name: "Album", platform: "jellyfin" }]),
      getFavoriteSongs: vi.fn().mockResolvedValue([]),
    } as unknown as MusicProvider;
  }

  function mount(config: BotConfig) {
    const netease = fakeProvider("netease");
    const jellyfin = jellyfinFake();
    const router = createMusicRouter(
      makeBotManager({ netease, jellyfin }),
      logger,
      config,
    );
    const app = express();
    app.use("/api/music", router);
    return { app, netease, jellyfin };
  }

  it("routes a platform-less /search to the default platform (netease)", async () => {
    const { app, netease, jellyfin } = mount(getDefaultConfig());
    const res = await request(app).get(`/api/music/search?q=hello&botId=${BOT_ID}`);
    expect(res.status).toBe(200);
    expect(netease.search).toHaveBeenCalledWith("hello", 20, 0);
    expect(jellyfin.search).not.toHaveBeenCalled();
  });

  it("rejects a disabled platform with 400 without calling its provider", async () => {
    // Default config leaves jellyfin (opt-in) disabled.
    const { app, jellyfin } = mount(getDefaultConfig());
    const res = await request(app).get(`/api/music/search?q=hello&platform=jellyfin&botId=${BOT_ID}`);
    expect(res.status).toBe(400);
    expect(jellyfin.search).not.toHaveBeenCalled();
  });

  it("allows an explicitly enabled jellyfin platform", async () => {
    const config = getDefaultConfig();
    config.enabledProviders = [...config.enabledProviders, "jellyfin"];
    const { app, jellyfin } = mount(config);
    const res = await request(app).get(`/api/music/search?q=hello&platform=jellyfin&botId=${BOT_ID}`);
    expect(res.status).toBe(200);
    expect(jellyfin.search).toHaveBeenCalledWith("hello", 20, 0);
  });

  it("GET /providers reports enabled sources and the default platform", async () => {
    const { app } = mount(getDefaultConfig());
    const res = await request(app).get("/api/music/providers");
    expect(res.status).toBe(200);
    expect(res.body.default).toBe("netease");
    expect(res.body.enabled).toContain("netease");
    expect(res.body.enabled).toContain("local"); // localAudioEnabled defaults on
    expect(res.body.enabled).not.toContain("jellyfin"); // opt-in, off by default
    expect(res.body.enabled).not.toContain("spotify"); // spotify.enabled defaults off
  });

  it("GET /providers reports a configured defaultPlatform override (#126)", async () => {
    const config = getDefaultConfig();
    config.defaultPlatform = "qq"; // operator prefers QQ over the priority order
    const { app } = mount(config);
    const res = await request(app).get("/api/music/providers");
    expect(res.status).toBe(200);
    expect(res.body.default).toBe("qq");
  });

  it("routes a platform-less /search to the configured defaultPlatform (#126)", async () => {
    const config = getDefaultConfig();
    config.defaultPlatform = "bilibili";
    const { app, netease } = mount(config);
    const res = await request(app).get(`/api/music/search?q=hello&botId=${BOT_ID}`);
    expect(res.status).toBe(200);
    // Default is now bilibili, so the netease provider must NOT be hit.
    expect(netease.search).not.toHaveBeenCalled();
  });

  /** Default config plus the opt-in jellyfin source enabled. */
  function configWithJellyfin() {
    const config = getDefaultConfig();
    config.enabledProviders = [...config.enabledProviders, "jellyfin"];
    return config;
  }

  it("GET /jellyfin/latest-albums returns provider data", async () => {
    const { app, jellyfin } = mount(configWithJellyfin());
    const res = await request(app).get(`/api/music/jellyfin/latest-albums?limit=5&botId=${BOT_ID}`);
    expect(res.status).toBe(200);
    expect(
      (jellyfin as unknown as { getLatestAlbums: ReturnType<typeof vi.fn> }).getLatestAlbums,
    ).toHaveBeenCalledWith(5);
    expect(res.body.albums).toHaveLength(1);
  });

  it("GET /jellyfin/latest-albums is 400 when jellyfin is disabled (the default)", async () => {
    const { app } = mount(getDefaultConfig());
    const res = await request(app).get(`/api/music/jellyfin/latest-albums?botId=${BOT_ID}`);
    expect(res.status).toBe(400);
  });

  it("GET /jellyfin/favorites denies unauthenticated/guest access", async () => {
    const { app } = mount(configWithJellyfin());
    const res = await request(app).get(`/api/music/jellyfin/favorites?botId=${BOT_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("music router POST /quality — per-bot persistence", () => {
  let tmpDir: string;
  let botDb: BotDatabase;
  let app: express.Express;
  let cookie: string;
  let providers: Record<string, MusicProvider>;

  /** A provider whose in-memory quality is settable and readable, like the real
   *  ones. */
  function qualityProvider(platform: MusicProvider["platform"], initial: string): MusicProvider {
    let q = initial;
    return {
      platform,
      search: vi.fn().mockResolvedValue(empty),
      getAuthStatus: vi.fn().mockResolvedValue({ loggedIn: true, vip: true }),
      getQuality: vi.fn(() => q),
      setQuality: vi.fn((v: string) => { q = v; }),
    } as unknown as MusicProvider;
  }

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const admin = await users.createUser("admin", "pw-admin", "admin");
    cookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(admin.id).token}`;
    // bot_music_quality has an FK on bot_instances(id) — insert the parent row.
    botDb.saveBotInstance({
      id: BOT_ID,
      name: "B",
      serverAddress: "x",
      serverPort: 9987,
      nickname: "n",
      defaultChannel: "",
      channelId: "",
      channelPassword: "",
      autoStart: false,
      serverProtocol: "",
      ts6ApiKey: "",
      serverPassword: "",
    });

    tmpDir = mkdtempSync(join(tmpdir(), "musicquality-"));

    providers = {
      netease: qualityProvider("netease", "exhigh"),
      qq: qualityProvider("qq", "exhigh"),
      bilibili: qualityProvider("bilibili", "high"),
      kugou: qualityProvider("kugou", "128"),
      jellyfin: qualityProvider("jellyfin", "direct"),
    };

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions, createPermissionStore(botDb.db), () => getDefaultConfig().guestMode));
    app.use(
      "/api/music",
      createMusicRouter(makeBotManager(providers), logger, getDefaultConfig(), botDb),
    );
  });

  afterEach(() => {
    botDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies and persists a platform-specific quality change per bot", async () => {
    const res = await request(app)
      .post("/api/music/quality")
      .set("Cookie", cookie)
      .send({ botId: BOT_ID, platform: "netease", quality: "lossless" });
    expect(res.status).toBe(200);
    expect(providers.netease.setQuality).toHaveBeenCalledWith("lossless");
    // Persisted to the per-bot DB row and readable back.
    expect(botDb.getMusicQuality(BOT_ID)).toEqual({ netease: "lossless" });
  });

  it("supports the jellyfin platform tiers per bot", async () => {
    const res = await request(app)
      .post("/api/music/quality")
      .set("Cookie", cookie)
      .send({ botId: BOT_ID, platform: "jellyfin", quality: "320" });
    expect(res.status).toBe(200);
    expect(providers.jellyfin.setQuality).toHaveBeenCalledWith("320");
    expect(botDb.getMusicQuality(BOT_ID)).toEqual({ jellyfin: "320" });
  });

  it("rejects a foreign quality value for the platform", async () => {
    const res = await request(app)
      .post("/api/music/quality")
      .set("Cookie", cookie)
      .send({ botId: BOT_ID, platform: "jellyfin", quality: "lossless" });
    expect(res.status).toBe(400);
    expect(providers.jellyfin.setQuality).not.toHaveBeenCalled();
  });

  it("requires a platform", async () => {
    const res = await request(app)
      .post("/api/music/quality")
      .set("Cookie", cookie)
      .send({ botId: BOT_ID, quality: "lossless" });
    expect(res.status).toBe(400);
  });
});
