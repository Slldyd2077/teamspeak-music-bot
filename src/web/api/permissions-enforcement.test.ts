import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createPlayerRouter } from "./player.js";
import { createBotRouter } from "./bot.js";
import { createAuthRouter } from "./auth.js";
import { createMusicRouter } from "./music.js";
import { createFavoritesRouter } from "./favorites.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";

const logger = pino({ level: "silent" });

// --- minimal stubs --------------------------------------------------------

const ALLOWED_BOT = "bot-allowed";

// A fake bot whose methods all no-op / return benign values so the real
// handlers run to completion without 500ing. We only assert that the
// permission/bot-access gate let the request THROUGH (status !== 403).
function makeFakeBot(id: string) {
  return {
    id,
    executeCommand: async () => "ok",
    getStatus: () => ({ id }),
    getQueue: () => [],
    getProfileManager: () => ({ getConfig: () => ({}), updateConfig: () => {}, setCustomAvatar: () => {} }),
  };
}

function makeBotManager() {
  const bot = makeFakeBot(ALLOWED_BOT);
  return {
    getBot: (id: string) => (id === ALLOWED_BOT ? bot : undefined),
    getAllBots: () => [bot],
    getBotConfig: () => undefined,
    createBot: async () => bot,
    updateBot: () => {},
    removeBot: async () => {},
    startBot: async () => {},
    stopBot: () => {},
  } as any;
}

function makeProvider() {
  return {
    platform: "netease",
    getQuality: () => "high",
    setQuality: () => {},
    getAuthStatus: async () => ({ loggedIn: false }),
    getQrCode: async () => ({ key: "k", url: "u" }),
    getCookie: () => "c",
    setCookie: () => {},
    search: async () => ({ songs: [], albums: [], playlists: [] }),
  } as any;
}

// Build one app mounting all four real routers, with req.user injected by a
// middleware placed BEFORE the routers (mimicking what requireAuth does).
function makeApp(user: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = user; next(); });

  const botManager = makeBotManager();
  const provider = makeProvider();

  app.use("/api/player", createPlayerRouter(botManager, logger));
  app.use(
    "/api/bot",
    createBotRouter(
      botManager,
      { idleTimeoutMinutes: 0 } as any,
      "/tmp/config.json",
      logger,
      { getBotInstances: () => [], getCustomAvatarPath: () => null, setCustomAvatarPath: () => {} } as any,
      { read: () => null, write: () => "x", remove: () => {} } as any,
    ),
  );
  app.use("/api/auth", createAuthRouter(provider, provider, provider, logger));
  app.use("/api/music", createMusicRouter(provider, provider, provider, logger));

  return app;
}

const member = (caps: string[], bots: "all" | string[]) => ({
  id: "u1",
  username: "alice",
  role: "member" as const,
  capabilities: new Set(caps),
  bots: bots === "all" ? ("all" as const) : new Set(bots),
});

const admin = {
  id: "a",
  username: "admin",
  role: "admin" as const,
  capabilities: new Set<string>(),
  bots: "all" as const,
};

describe("permission enforcement on action routes", () => {
  describe("player.control", () => {
    it("403 for member WITHOUT player.control", async () => {
      const app = makeApp(member([], [ALLOWED_BOT]));
      const res = await request(app).post(`/api/player/${ALLOWED_BOT}/pause`);
      expect(res.status).toBe(403);
    });

    it("NOT 403 for member WITH player.control + bot in allow-list", async () => {
      const app = makeApp(member(["player.control"], [ALLOWED_BOT]));
      const res = await request(app).post(`/api/player/${ALLOWED_BOT}/pause`);
      expect(res.status).not.toBe(403);
    });

    it("403 for member WITH player.control but bot NOT in allow-list", async () => {
      const app = makeApp(member(["player.control"], ["other-bot"]));
      const res = await request(app).post(`/api/player/${ALLOWED_BOT}/pause`);
      expect(res.status).toBe(403);
    });
  });

  describe("player.queue", () => {
    it("403 for member WITHOUT player.queue", async () => {
      const app = makeApp(member(["player.control"], [ALLOWED_BOT]));
      const res = await request(app).post(`/api/player/${ALLOWED_BOT}/clear`);
      expect(res.status).toBe(403);
    });

    it("NOT 403 for member WITH player.queue", async () => {
      const app = makeApp(member(["player.queue"], [ALLOWED_BOT]));
      const res = await request(app).post(`/api/player/${ALLOWED_BOT}/clear`);
      expect(res.status).not.toBe(403);
    });
  });

  describe("bot.manage", () => {
    it("403 for member WITHOUT bot.manage on POST /api/bot", async () => {
      const app = makeApp(member([], "all"));
      const res = await request(app)
        .post("/api/bot")
        .send({ name: "n", serverAddress: "s", nickname: "nick" });
      expect(res.status).toBe(403);
    });

    it("NOT 403 for member WITH bot.manage on POST /api/bot", async () => {
      const app = makeApp(member(["bot.manage"], "all"));
      const res = await request(app)
        .post("/api/bot")
        .send({ name: "n", serverAddress: "s", nickname: "nick" });
      expect(res.status).not.toBe(403);
    });

    it("403 for member WITH bot.manage but bot NOT in allow-list on POST /api/bot/:id/start", async () => {
      const app = makeApp(member(["bot.manage"], ["other-bot"]));
      const res = await request(app).post(`/api/bot/${ALLOWED_BOT}/start`);
      expect(res.status).toBe(403);
    });

    it("NOT 403 for member WITH bot.manage + bot in allow-list on POST /api/bot/:id/start", async () => {
      const app = makeApp(member(["bot.manage"], [ALLOWED_BOT]));
      const res = await request(app).post(`/api/bot/${ALLOWED_BOT}/start`);
      expect(res.status).not.toBe(403);
    });
  });

  describe("platform.auth", () => {
    it("403 for member WITHOUT platform.auth on POST /api/auth/cookie", async () => {
      const app = makeApp(member([], "all"));
      const res = await request(app).post("/api/auth/cookie").send({ cookie: "c" });
      expect(res.status).toBe(403);
    });

    it("NOT 403 for member WITH platform.auth on POST /api/auth/cookie", async () => {
      const app = makeApp(member(["platform.auth"], "all"));
      const res = await request(app).post("/api/auth/cookie").send({ cookie: "c" });
      expect(res.status).not.toBe(403);
    });
  });

  describe("quality", () => {
    it("403 for member WITHOUT quality on POST /api/music/quality", async () => {
      const app = makeApp(member([], "all"));
      const res = await request(app).post("/api/music/quality").send({ quality: "high" });
      expect(res.status).toBe(403);
    });

    it("NOT 403 for member WITH quality on POST /api/music/quality", async () => {
      const app = makeApp(member(["quality"], "all"));
      const res = await request(app).post("/api/music/quality").send({ quality: "high" });
      expect(res.status).not.toBe(403);
    });

    it("GET /api/music/quality is 403 for guests, allowed for members", async () => {
      const guestApp = makeApp(guest());
      expect((await request(guestApp).get("/api/music/quality")).status).toBe(403);
      const memberApp = makeApp(member([], "all"));
      expect((await request(memberApp).get("/api/music/quality")).status).toBe(200);
    });
  });

  // The operator's personal-account reads (their recommendations, FM, and
  // playlists) must never leak to login-less guests. These routes are gated
  // with requireNotGuest; generic search/browse stays open.
  describe("operator personal-data reads are denied to guests", () => {
    const personalRoutes = [
      "/api/music/recommend/songs",
      "/api/music/personal/fm",
      "/api/music/user/playlists",
    ];

    for (const route of personalRoutes) {
      it(`GET ${route} is 403 for a guest`, async () => {
        const app = makeApp(guest());
        expect((await request(app).get(route)).status).toBe(403);
      });

      it(`GET ${route} is NOT 403 for a member`, async () => {
        const app = makeApp(member([], "all"));
        expect((await request(app).get(route)).status).not.toBe(403);
      });
    }
  });

  describe("read-only routes stay open", () => {
    it("GET /api/auth/status not gated", async () => {
      const app = makeApp(member([], "all"));
      const res = await request(app).get("/api/auth/status");
      expect(res.status).not.toBe(403);
    });

    it("GET /api/music/quality readable by members, denied to guests", async () => {
      const app = makeApp(member([], "all"));
      const res = await request(app).get("/api/music/quality");
      expect(res.status).not.toBe(403);
    });

    it("GET /api/bot not gated", async () => {
      const app = makeApp(member([], "all"));
      const res = await request(app).get("/api/bot");
      expect(res.status).not.toBe(403);
    });

    it("GET /api/auth/status and /api/auth/qrcode/status are 403 for guests", async () => {
      const app = makeApp(guest());
      expect((await request(app).get("/api/auth/status")).status).toBe(403);
      expect((await request(app).get("/api/auth/qrcode/status?key=k")).status).toBe(403);
    });
  });

  describe("admin bypasses every gate", () => {
    let app: express.Express;
    beforeEach(() => { app = makeApp(admin); });

    it("player.control", async () => {
      expect((await request(app).post(`/api/player/${ALLOWED_BOT}/pause`)).status).not.toBe(403);
    });
    it("player.queue", async () => {
      expect((await request(app).post(`/api/player/${ALLOWED_BOT}/clear`)).status).not.toBe(403);
    });
    it("bot.manage POST /api/bot", async () => {
      const res = await request(app).post("/api/bot").send({ name: "n", serverAddress: "s", nickname: "nick" });
      expect(res.status).not.toBe(403);
    });
    it("bot.manage POST /api/bot/:id/start", async () => {
      expect((await request(app).post(`/api/bot/${ALLOWED_BOT}/start`)).status).not.toBe(403);
    });
    it("platform.auth POST /api/auth/cookie", async () => {
      expect((await request(app).post("/api/auth/cookie").send({ cookie: "c" })).status).not.toBe(403);
    });
    it("quality POST /api/music/quality", async () => {
      expect((await request(app).post("/api/music/quality").send({ quality: "high" })).status).not.toBe(403);
    });
  });
});

// --------------------------------------------------------------------------
// Guest enforcement on the player routes. Guests carry per-flag permissions
// (req.user.guest) instead of capabilities; authorize() opens a route only
// when its guestFlag is set AND enabled. Routes with no guestFlag are denied
// to guests no matter which flags are on. We reuse makeApp() (it injects
// req.user and mounts the real player router over the fake bot manager) and
// assert purely on 403-vs-not-403 — a 200/500 from the fake bot both prove
// the gate let the request through.
// --------------------------------------------------------------------------

const SONG = { id: "1", platform: "netease", name: "x", artist: "y" };

// Build a guest user with all flags off, then override the ones passed in.
const guest = (perms: Partial<Record<string, boolean>> = {}) => ({
  id: "__guest__",
  username: "游客",
  role: "guest" as const,
  capabilities: new Set<string>(),
  bots: "all" as const,
  guest: {
    addToQueue: false,
    playNext: false,
    playNow: false,
    skip: false,
    transport: false,
    removeClear: false,
    playMode: false,
    ...perms,
  },
});

const mountGuest = (perms: Partial<Record<string, boolean>> = {}) => makeApp(guest(perms));

describe("guest enforcement on player routes", () => {
  it("addToQueue flag gates POST /add, /add-song, /add-by-id", async () => {
    const allow = mountGuest({ addToQueue: true });
    const deny = mountGuest({ addToQueue: false });
    for (const path of ["add", "add-song", "add-by-id"]) {
      expect((await request(allow).post(`/api/player/${ALLOWED_BOT}/${path}`).send({ song: SONG, songId: "1", query: "x" })).status).not.toBe(403);
      expect((await request(deny).post(`/api/player/${ALLOWED_BOT}/${path}`).send({ song: SONG, songId: "1", query: "x" })).status).toBe(403);
    }
  });

  it("playNext flag gates /play-next-song", async () => {
    expect((await request(mountGuest({ playNext: true })).post(`/api/player/${ALLOWED_BOT}/play-next-song`).send({ song: SONG })).status).not.toBe(403);
    expect((await request(mountGuest({})).post(`/api/player/${ALLOWED_BOT}/play-next-song`).send({ song: SONG })).status).toBe(403);
  });

  it("playNow flag gates the new /play-now-song", async () => {
    expect((await request(mountGuest({ playNow: true })).post(`/api/player/${ALLOWED_BOT}/play-now-song`).send({ song: SONG })).status).not.toBe(403);
    expect((await request(mountGuest({})).post(`/api/player/${ALLOWED_BOT}/play-now-song`).send({ song: SONG })).status).toBe(403);
    // playNext does NOT open play-now-song, and playNow does NOT open play-next-song.
    expect((await request(mountGuest({ playNext: true })).post(`/api/player/${ALLOWED_BOT}/play-now-song`).send({ song: SONG })).status).toBe(403);
    expect((await request(mountGuest({ playNow: true })).post(`/api/player/${ALLOWED_BOT}/play-next-song`).send({ song: SONG })).status).toBe(403);
  });

  it("skip flag gates /next", async () => {
    expect((await request(mountGuest({ skip: true })).post(`/api/player/${ALLOWED_BOT}/next`)).status).not.toBe(403);
    expect((await request(mountGuest({})).post(`/api/player/${ALLOWED_BOT}/next`)).status).toBe(403);
  });

  it("transport flag gates /pause, /resume, /seek, /volume", async () => {
    const allow = mountGuest({ transport: true });
    const deny = mountGuest({ transport: false });
    expect((await request(allow).post(`/api/player/${ALLOWED_BOT}/pause`)).status).not.toBe(403);
    expect((await request(allow).post(`/api/player/${ALLOWED_BOT}/resume`)).status).not.toBe(403);
    expect((await request(allow).post(`/api/player/${ALLOWED_BOT}/seek`).send({ position: 0 })).status).not.toBe(403);
    expect((await request(allow).post(`/api/player/${ALLOWED_BOT}/volume`).send({ volume: 50 })).status).not.toBe(403);
    expect((await request(deny).post(`/api/player/${ALLOWED_BOT}/pause`)).status).toBe(403);
    expect((await request(deny).post(`/api/player/${ALLOWED_BOT}/resume`)).status).toBe(403);
    expect((await request(deny).post(`/api/player/${ALLOWED_BOT}/seek`).send({ position: 0 })).status).toBe(403);
    expect((await request(deny).post(`/api/player/${ALLOWED_BOT}/volume`).send({ volume: 50 })).status).toBe(403);
  });

  it("playMode flag gates /mode, /fm", async () => {
    const allow = mountGuest({ playMode: true });
    const deny = mountGuest({ playMode: false });
    expect((await request(allow).post(`/api/player/${ALLOWED_BOT}/mode`).send({ mode: "seq" })).status).not.toBe(403);
    expect((await request(allow).post(`/api/player/${ALLOWED_BOT}/fm`).send({})).status).not.toBe(403);
    expect((await request(deny).post(`/api/player/${ALLOWED_BOT}/mode`).send({ mode: "seq" })).status).toBe(403);
    expect((await request(deny).post(`/api/player/${ALLOWED_BOT}/fm`).send({})).status).toBe(403);
  });

  it("removeClear flag gates /clear and DELETE /queue/:index", async () => {
    const allow = mountGuest({ removeClear: true });
    const deny = mountGuest({ removeClear: false });
    expect((await request(allow).post(`/api/player/${ALLOWED_BOT}/clear`)).status).not.toBe(403);
    expect((await request(allow).delete(`/api/player/${ALLOWED_BOT}/queue/0`)).status).not.toBe(403);
    expect((await request(deny).post(`/api/player/${ALLOWED_BOT}/clear`)).status).toBe(403);
    expect((await request(deny).delete(`/api/player/${ALLOWED_BOT}/queue/0`)).status).toBe(403);
  });

  it("each guest flag opens exactly its own route(s) — a single flag does not leak", async () => {
    // With only addToQueue on, a transport route stays denied.
    expect((await request(mountGuest({ addToQueue: true })).post(`/api/player/${ALLOWED_BOT}/pause`)).status).toBe(403);
    // With only transport on, an add route stays denied.
    expect((await request(mountGuest({ transport: true })).post(`/api/player/${ALLOWED_BOT}/add-song`).send({ song: SONG })).status).toBe(403);
  });

  it("guests are always denied /play, /prev, /stop, /play-song, /play-at, /play-playlist, /play-album, /playlist, /profile even with ALL flags on", async () => {
    const all = mountGuest({
      addToQueue: true,
      playNext: true,
      playNow: true,
      skip: true,
      transport: true,
      removeClear: true,
      playMode: true,
    });
    expect((await request(all).post(`/api/player/${ALLOWED_BOT}/play`).send({ query: "x" })).status).toBe(403);
    expect((await request(all).post(`/api/player/${ALLOWED_BOT}/prev`)).status).toBe(403);
    expect((await request(all).post(`/api/player/${ALLOWED_BOT}/stop`)).status).toBe(403);
    expect((await request(all).post(`/api/player/${ALLOWED_BOT}/play-song`).send({ song: SONG })).status).toBe(403);
    expect((await request(all).post(`/api/player/${ALLOWED_BOT}/play-at`).send({ index: 0 })).status).toBe(403);
    expect((await request(all).post(`/api/player/${ALLOWED_BOT}/play-playlist`).send({ playlistId: "1" })).status).toBe(403);
    expect((await request(all).post(`/api/player/${ALLOWED_BOT}/play-album`).send({ albumId: "1" })).status).toBe(403);
    expect((await request(all).post(`/api/player/${ALLOWED_BOT}/playlist`).send({ playlistId: "1" })).status).toBe(403);
    expect((await request(all).put(`/api/player/${ALLOWED_BOT}/profile`).send({})).status).toBe(403);
  });

  it("members are unaffected — player.queue still reaches /add-song", async () => {
    const m = makeApp(member(["player.queue"], [ALLOWED_BOT]));
    expect((await request(m).post(`/api/player/${ALLOWED_BOT}/add-song`).send({ song: SONG })).status).not.toBe(403);
  });
});

// --------------------------------------------------------------------------
// Favorites are member-only: the router keys everything off req.user.id and
// all guests share the __guest__ principal, so a guest must never reach it.
// server.ts gates the mount with requireNotGuest; we mirror that mount here
// and assert a guest gets 403 (the requireNotGuest guard runs before any
// handler, so the fake database is never touched).
// --------------------------------------------------------------------------

function makeFavoritesApp(user: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = user; next(); });
  const fakeDb = {
    getFavorites: () => [],
    addFavorite: () => {},
    removeFavorite: () => {},
    isFavorited: () => false,
  } as any;
  app.use("/api/favorites", requireNotGuest, createFavoritesRouter(fakeDb, logger));
  return app;
}

describe("favorites are denied to guests", () => {
  it("403 for a guest on GET /api/favorites", async () => {
    const app = makeFavoritesApp(guest());
    expect((await request(app).get("/api/favorites")).status).toBe(403);
  });

  it("403 for a guest on GET /api/favorites/check", async () => {
    const app = makeFavoritesApp(guest());
    expect((await request(app).get("/api/favorites/check?platform=netease&playlistId=x")).status).toBe(403);
  });

  it("403 for a guest on POST /api/favorites", async () => {
    const app = makeFavoritesApp(guest());
    const res = await request(app).post("/api/favorites").send({ platform: "netease", playlistId: "x", name: "n" });
    expect(res.status).toBe(403);
  });

  it("NOT 403 for a member on GET /api/favorites", async () => {
    const app = makeFavoritesApp(member([], "all"));
    expect((await request(app).get("/api/favorites")).status).not.toBe(403);
  });
});
