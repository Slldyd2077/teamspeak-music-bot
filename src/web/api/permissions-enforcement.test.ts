import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createPlayerRouter } from "./player.js";
import { createBotRouter } from "./bot.js";
import { createAuthRouter } from "./auth.js";
import { createMusicRouter } from "./music.js";

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
  });

  describe("read-only routes stay open", () => {
    it("GET /api/auth/status not gated", async () => {
      const app = makeApp(member([], "all"));
      const res = await request(app).get("/api/auth/status");
      expect(res.status).not.toBe(403);
    });

    it("GET /api/music/quality not gated", async () => {
      const app = makeApp(member([], "all"));
      const res = await request(app).get("/api/music/quality");
      expect(res.status).not.toBe(403);
    });

    it("GET /api/bot not gated", async () => {
      const app = makeApp(member([], "all"));
      const res = await request(app).get("/api/bot");
      expect(res.status).not.toBe(403);
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
