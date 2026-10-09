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
import { createMusicRouter, createLocalUploadBody } from "./music.js";
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

// #149: video containers must survive the transport layer. Before this the
// express.raw type filter only matched audio/*, video/webm and
// application/octet-stream, so a browser-sent video/mp4 body was never parsed
// and the handler answered 400 "raw audio body is required".
function createScopedMusicRouter(
  netease: MusicProvider, qq: MusicProvider, bilibili: MusicProvider,
  routerLogger: typeof logger, local?: MusicProvider, config?: BotConfig,
) {
  return createMusicRouter(makeBotManager({ netease, qq, bilibili, ...(local ? { local } : {}) }), routerLogger, config);
}

describe("music router POST /local/upload — content types and size cap (#149)", () => {
  let app: express.Express;
  let botDb: BotDatabase;
  let cookie: string;
  let uploadAudio: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const admin = await users.createUser("admin", "pw-admin", "admin");
    cookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(admin.id).token}`;

    uploadAudio = vi.fn(async (input: { originalName: string }) => ({
      id: "local-1", name: input.originalName, artist: "本地上传", album: "本地音乐",
      duration: 1, coverUrl: "", platform: "local",
    }));
    const local = { platform: "local", search: vi.fn().mockResolvedValue(empty), uploadAudio } as unknown as MusicProvider;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions, createPermissionStore(botDb.db), () => getDefaultConfig().guestMode));
    app.use("/api/music", createScopedMusicRouter(
      fakeProvider("netease"), fakeProvider("qq"), fakeProvider("bilibili"),
      pino({ level: "silent" }), local, getDefaultConfig(),
    ));
  });

  afterEach(() => botDb.close());

  const post = (contentType: string, body: Buffer, name = "clip.mp4") =>
    request(app)
      .post("/api/music/local/upload")
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .set("X-Filename", encodeURIComponent(name))
      .send(body);

  it("accepts the video MIME types browsers actually send", async () => {
    // These are what Chrome/Firefox put on a File for .mp4/.mov/.avi/.mkv.
    for (const ct of ["video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska", "video/webm"]) {
      uploadAudio.mockClear();
      const res = await post(ct, Buffer.from("fake video bytes"));
      expect(res.status, `content-type ${ct}`).toBe(200);
      expect(uploadAudio).toHaveBeenCalledOnce();
      expect(res.body.song.platform).toBe("local");
    }
  });

  it("still accepts audio and octet-stream bodies", async () => {
    for (const ct of ["audio/mpeg", "audio/flac", "application/octet-stream"]) {
      uploadAudio.mockClear();
      const res = await post(ct, Buffer.from("fake audio"), "tune.mp3");
      expect(res.status, `content-type ${ct}`).toBe(200);
      expect(uploadAudio).toHaveBeenCalledOnce();
    }
  });

  it("passes the decoded filename and the content type through to the provider", async () => {
    await post("video/mp4", Buffer.from("bytes"), "我的 视频.mp4");
    expect(uploadAudio).toHaveBeenCalledWith(
      expect.objectContaining({ originalName: "我的 视频.mp4", mimeType: "video/mp4" }),
    );
  });

  it("surfaces a provider rejection as a 400 with its message", async () => {
    uploadAudio.mockRejectedValueOnce(new Error("这个视频里没有音轨，无法播放"));
    const res = await post("video/mp4", Buffer.from("bytes"));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("这个视频里没有音轨，无法播放");
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/music/local/upload")
      .set("Content-Type", "video/mp4")
      .send(Buffer.from("bytes"));
    expect(res.status).toBe(401);
  });

  it("rejects an oversize body as JSON, not an HTML stack trace", async () => {
    // Same middleware the route mounts, built with a small limit so the test
    // does not have to allocate half a gigabyte to reach the cap.
    const tiny = express();
    const reached = vi.fn();
    tiny.post("/u", createLocalUploadBody("1kb"), (_req, res) => { reached(); res.json({ ok: true }); });

    const res = await request(tiny)
      .post("/u")
      .set("Content-Type", "video/mp4")
      .send(Buffer.alloc(4096, 1));

    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toContain("文件太大");
    // The HTML default handler leaked absolute server paths and a stack.
    expect(res.text).not.toMatch(/node_modules|<\/pre>|at read/);
    expect(reached).not.toHaveBeenCalled();
  });

  it("lets a body under the cap through the same middleware", async () => {
    const tiny = express();
    tiny.post("/u", createLocalUploadBody("1kb"), (req, res) => {
      res.json({ bytes: (req.body as Buffer).length });
    });
    const res = await request(tiny)
      .post("/u")
      .set("Content-Type", "video/mp4")
      .send(Buffer.alloc(512, 1));
    expect(res.status).toBe(200);
    expect(res.body.bytes).toBe(512);
  });

  it("rejects local uploads when the feature is switched off", async () => {
    const off = getDefaultConfig();
    off.localAudioEnabled = false;
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const a2 = await users.createUser("admin2", "pw-admin2", "admin");
    const c2 = `${SESSION_COOKIE_NAME}=${sessions.createSession(a2.id).token}`;
    const app2 = express();
    app2.use(cookieParser());
    app2.use("/api", createRequireAuth(sessions, createPermissionStore(botDb.db), () => getDefaultConfig().guestMode));
    app2.use("/api/music", createScopedMusicRouter(
      fakeProvider("netease"), fakeProvider("qq"), fakeProvider("bilibili"),
      pino({ level: "silent" }),
      { platform: "local", search: vi.fn(), uploadAudio } as unknown as MusicProvider, off,
    ));
    const res = await request(app2)
      .post("/api/music/local/upload")
      .set("Cookie", c2)
      .set("Content-Type", "video/mp4")
      .send(Buffer.from("bytes"));
    expect(res.status).toBe(403);
    expect(uploadAudio).not.toHaveBeenCalled();
  });
});

describe("music router GET /bilibili/parts", () => {
  it("returns 400 when bvid is missing", async () => {
    const router = createScopedMusicRouter(
      fakeProvider("netease"),
      fakeProvider("qq"),
      fakeProvider("bilibili"),
      pino({ level: "silent" })
    );
    const app = express();
    app.use("/api/music", router);

    const res = await request(app).get("/api/music/bilibili/parts?botId=bot-1");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bvid is required");
  });

  it("returns parts from bilibili provider when available", async () => {
    const mockBilibili = {
      platform: "bilibili" as const,
      search: vi.fn(),
      getVideoParts: vi.fn().mockResolvedValue({
        bvid: "BV1test",
        title: "多P视频测试",
        parts: [
          { part: 1, cid: 101, title: "P1", duration: 100 },
          { part: 2, cid: 102, title: "P2", duration: 200 },
        ],
      }),
    };
    const router = createScopedMusicRouter(
      fakeProvider("netease"),
      fakeProvider("qq"),
      mockBilibili as unknown as MusicProvider,
      pino({ level: "silent" })
    );
    const app = express();
    app.use("/api/music", router);

    const res = await request(app).get("/api/music/bilibili/parts?bvid=BV1test&botId=bot-1");
    expect(res.status).toBe(200);
    expect(res.body.bvid).toBe("BV1test");
    expect(res.body.parts).toHaveLength(2);
    expect(mockBilibili.getVideoParts).toHaveBeenCalledWith("BV1test");
  });

  it("returns 404 when getVideoParts returns null", async () => {
    const mockBilibili = {
      platform: "bilibili" as const,
      search: vi.fn(),
      getVideoParts: vi.fn().mockResolvedValue(null),
    };
    const router = createScopedMusicRouter(
      fakeProvider("netease"),
      fakeProvider("qq"),
      mockBilibili as unknown as MusicProvider,
      pino({ level: "silent" })
    );
    const app = express();
    app.use("/api/music", router);

    const res = await request(app).get("/api/music/bilibili/parts?bvid=BV1notfound&botId=bot-1");
    expect(res.status).toBe(404);
  });
});

describe("music router GET /artist/:id", () => {
  it("requires a selected bot rather than using a global platform login", async () => {
    const app = express();
    app.use("/api/music", createMusicRouter(makeBotManager(), logger));
    expect((await request(app).get("/api/music/artist/1")).status).toBe(400);
  });

  it("rejects an artist lookup outside the member's bot scope", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).user = { role: "member", bots: new Set() };
      next();
    });
    app.use("/api/music", createMusicRouter(makeBotManager(), logger));
    expect((await request(app).get(`/api/music/artist/1?botId=${BOT_ID}`)).status).toBe(403);
  });
  function artistProvider(overrides: Record<string, unknown> = {}): MusicProvider {
    return {
      platform: "netease",
      search: vi.fn().mockResolvedValue(empty),
      getArtistDetail: vi.fn().mockResolvedValue({
        id: "6452",
        name: "Adele",
        avatarUrl: "http://p/1.jpg",
        platform: "netease",
        description: "English singer",
      }),
      getArtistSongs: vi.fn().mockResolvedValue([
        { id: "1", name: "Hello", artist: "Adele", album: "25", duration: 295, coverUrl: "c", platform: "netease" },
      ]),
      getArtistAlbums: vi.fn().mockResolvedValue([
        { id: "a1", name: "25", artist: "Adele", coverUrl: "c", songCount: 11, platform: "netease" },
      ]),
      ...overrides,
    } as unknown as MusicProvider;
  }

  function mount(netease: MusicProvider, qq: MusicProvider = fakeProvider("qq")) {
    const app = express();
    app.use("/api/music", createScopedMusicRouter(netease, qq, fakeProvider("bilibili"), pino({ level: "silent" })));
    return app;
  }

  it("returns artist detail, hot songs and albums for the requested platform", async () => {
    const netease = artistProvider();
    const res = await request(mount(netease)).get("/api/music/artist/6452?platform=netease&botId=bot-1");

    expect(res.status).toBe(200);
    expect(res.body.artist).toMatchObject({ id: "6452", name: "Adele", description: "English singer" });
    expect(res.body.songs).toHaveLength(1);
    expect(res.body.albums).toHaveLength(1);
    expect(netease.getArtistDetail).toHaveBeenCalledWith("6452");
    expect(netease.getArtistSongs).toHaveBeenCalledWith("6452");
    expect(netease.getArtistAlbums).toHaveBeenCalledWith("6452");
  });

  it("routes to the QQ provider when platform=qq", async () => {
    const qq = artistProvider({ platform: "qq" });
    const res = await request(mount(fakeProvider("netease"), qq)).get("/api/music/artist/abc?platform=qq&botId=bot-1");

    expect(res.status).toBe(200);
    expect(qq.getArtistDetail).toHaveBeenCalledWith("abc");
  });

  it("404s when the provider has no such artist", async () => {
    const netease = artistProvider({ getArtistDetail: vi.fn().mockResolvedValue(null) });
    const res = await request(mount(netease)).get("/api/music/artist/999?botId=bot-1");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Artist not found");
  });

  it("501s when the provider does not support artists at all", async () => {
    const res = await request(mount(fakeProvider("netease"))).get("/api/music/artist/1?botId=bot-1");
    expect(res.status).toBe(501);
    expect(res.body.error).toBe("Not supported by this provider");
  });

  it("degrades each leg independently — a failing songs/albums call still returns the hero", async () => {
    const netease = artistProvider({
      getArtistSongs: vi.fn().mockRejectedValue(new Error("boom")),
      getArtistAlbums: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const res = await request(mount(netease)).get("/api/music/artist/6452?botId=bot-1");

    expect(res.status).toBe(200);
    expect(res.body.artist.name).toBe("Adele");
    expect(res.body.songs).toEqual([]);
    expect(res.body.albums).toEqual([]);
  });

  it("tolerates a provider that only implements getArtistDetail", async () => {
    const netease = artistProvider({ getArtistSongs: undefined, getArtistAlbums: undefined });
    const res = await request(mount(netease)).get("/api/music/artist/6452?botId=bot-1");

    expect(res.status).toBe(200);
    expect(res.body.songs).toEqual([]);
    expect(res.body.albums).toEqual([]);
  });
});

describe("music router GET /search/all artist aggregation", () => {
  function searchProvider(platform: MusicProvider["platform"], artists: unknown[]): MusicProvider {
    return {
      platform,
      search: vi.fn().mockResolvedValue({ ...empty, artists }),
    } as unknown as MusicProvider;
  }

  it("merges artists from netease and qq and ignores sources without artists", async () => {
    const app = express();
    app.use(
      "/api/music",
      createScopedMusicRouter(
        searchProvider("netease", [{ id: "1", name: "N", avatarUrl: "", platform: "netease" }]),
        searchProvider("qq", [{ id: "2", name: "Q", avatarUrl: "", platform: "qq" }]),
        fakeProvider("bilibili"),
        pino({ level: "silent" })
      )
    );

    const res = await request(app).get("/api/music/search/all?q=adele&botId=bot-1");
    expect(res.status).toBe(200);
    expect(res.body.artists).toEqual([
      { id: "1", name: "N", avatarUrl: "", platform: "netease" },
      { id: "2", name: "Q", avatarUrl: "", platform: "qq" },
    ]);
  });
});
