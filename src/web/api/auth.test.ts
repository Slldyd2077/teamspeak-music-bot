import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import type { MusicProvider } from "../../music/provider.js";
import { getDefaultConfig, type JellyfinConfig } from "../../data/config.js";
import { createAuthRouter } from "./auth.js";
import type { CookieStore } from "../../music/auth.js";
import type { BotManager } from "../../bot/manager.js";
import type { BotInstance } from "../../bot/instance.js";

const BOT_ID = "bot-jf";

function mount(
  stored: Partial<JellyfinConfig>,
  user: unknown = { role: "admin" },
) {
  const config = getDefaultConfig();
  const testConnection = vi.fn().mockResolvedValue({ ok: true, serverName: "JF" });
  const configure = vi.fn();
  const jellyfin = {
    platform: "jellyfin",
    testConnection,
    configure,
  } as unknown as MusicProvider;
  const cookieStore = {
    load: (_botId: string, platform: string) =>
      platform === "jellyfin" ? JSON.stringify(stored) : "",
    save: vi.fn(),
  } as unknown as CookieStore;
  const bot = {
    id: BOT_ID,
    getProviderFor: (p: string) => (p === "jellyfin" ? jellyfin : ({ platform: p } as unknown as MusicProvider)),
  } as unknown as BotInstance;
  const botManager = {
    getBot: (id: string) => (id === BOT_ID ? bot : undefined),
    saveJellyfinCredentials: vi.fn(),
  } as unknown as BotManager;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as { user?: unknown }).user = user; next(); });
  app.use(
    "/api/auth",
    createAuthRouter(botManager, cookieStore, config, pino({ level: "silent" })),
  );
  return { app, testConnection, configure, cookieStore, botManager };
}

describe("auth router POST /jellyfin/test (per-bot)", () => {
  it("fills empty credential fields from the bot's stored blob (masked password case)", async () => {
    const { app, testConnection } = mount({
      serverUrl: "https://old.example.com",
      username: "bob",
      password: "stored-pw",
    });
    const res = await request(app)
      .post("/api/auth/jellyfin/test")
      .send({ botId: BOT_ID, serverUrl: "https://new.example.com", username: "bob", password: "" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://new.example.com",
        username: "bob",
        password: "stored-pw",
      }),
    );
  });

  it("passes freshly entered credentials through", async () => {
    const { app, testConnection } = mount({});
    await request(app).post("/api/auth/jellyfin/test").send({
      botId: BOT_ID,
      serverUrl: "https://jf.example.com",
      authMode: "apikey",
      apiKey: "key123",
      userId: "u1",
    });
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "apikey", apiKey: "key123", userId: "u1" }),
    );
  });

  it("is 403 for a member lacking platform.auth", async () => {
    const { app, testConnection } = mount({}, { role: "member", capabilities: new Set([]) });
    const res = await request(app).post("/api/auth/jellyfin/test").send({ botId: BOT_ID });
    expect(res.status).toBe(403);
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("requires a botId", async () => {
    const { app } = mount({});
    const res = await request(app).post("/api/auth/jellyfin/test").send({});
    expect(res.status).toBe(400);
  });
});

describe("auth router POST /jellyfin/login (per-bot)", () => {
  it("persists credentials, reconfigures the live provider, and verifies", async () => {
    const { app, configure, botManager } = mount({});
    const res = await request(app).post("/api/auth/jellyfin/login").send({
      botId: BOT_ID,
      serverUrl: "https://jf.example.com",
      authMode: "userpass",
      username: "alice",
      password: "pw",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(botManager.saveJellyfinCredentials).toHaveBeenCalledWith(
      BOT_ID,
      expect.objectContaining({ serverUrl: "https://jf.example.com", username: "alice" }),
    );
    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: "https://jf.example.com" }),
    );
  });

  it("rejects a missing serverUrl", async () => {
    const { app, configure } = mount({});
    const res = await request(app).post("/api/auth/jellyfin/login").send({ botId: BOT_ID });
    expect(res.status).toBe(400);
    expect(configure).not.toHaveBeenCalled();
  });
});

describe("auth router DELETE /cookie (platform logout)", () => {
  function mount(user: unknown = { role: "admin" }) {
    const del = vi.fn();
    const setCookie = vi.fn();
    const netease = {
      platform: "netease",
      setCookie,
    } as unknown as MusicProvider;
    const cookieStore = {
      load: () => "",
      save: vi.fn(),
      delete: del,
    } as unknown as CookieStore;
    const bot = {
      id: BOT_ID,
      getProviderFor: (p: string) =>
        p === "netease" ? netease : ({ platform: p, setCookie: vi.fn(), configure: vi.fn() } as unknown as MusicProvider),
    } as unknown as BotInstance;
    const botManager = { getBot: (id: string) => (id === BOT_ID ? bot : undefined) } as unknown as BotManager;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { user?: unknown }).user = user; next(); });
    app.use("/api/auth", createAuthRouter(botManager, cookieStore, undefined, pino({ level: "silent" })));
    return { app, del, setCookie };
  }

  it("deletes the bot's saved cookie and resets the live provider", async () => {
    const { app, del, setCookie } = mount();
    const res = await request(app).delete(`/api/auth/cookie?platform=netease&botId=${BOT_ID}`);
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledWith(BOT_ID, "netease");
    expect(setCookie).toHaveBeenCalledWith("");
  });

  it("rejects platforms with no login to clear", async () => {
    const { app, del } = mount();
    const res = await request(app).delete(`/api/auth/cookie?platform=youtube&botId=${BOT_ID}`);
    expect(res.status).toBe(400);
    expect(del).not.toHaveBeenCalled();
  });

  it("requires a platform", async () => {
    const { app } = mount();
    const res = await request(app).delete(`/api/auth/cookie?botId=${BOT_ID}`);
    expect(res.status).toBe(400);
  });

  it("is 403 for a member lacking platform.auth", async () => {
    const { app } = mount({ role: "member", capabilities: new Set([]) });
    const res = await request(app).delete(`/api/auth/cookie?platform=netease&botId=${BOT_ID}`);
    expect(res.status).toBe(403);
  });
});
