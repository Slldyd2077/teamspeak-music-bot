import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createSessionStore } from "../../data/sessions.js";
import { createAvatarStore } from "../../data/avatars.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createBotRouter } from "./bot.js";
import { getDefaultConfig, type BotConfig } from "../../data/config.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";
import type { BotManager } from "../../bot/manager.js";

/** Records every updateIdleTimeout / updateAutoPause call so the test can assert propagation. */
function makeFakeBot() {
  return {
    idleTimeoutCalls: [] as number[],
    autoPauseCalls: [] as boolean[],
    updateIdleTimeout(minutes: number) {
      this.idleTimeoutCalls.push(minutes);
    },
    updateAutoPause(enabled: boolean) {
      this.autoPauseCalls.push(enabled);
    },
  };
}

describe("bot router /settings", () => {
  let botDb: BotDatabase;
  let app: express.Express;
  let cookie: string;
  let config: BotConfig;
  let configPath: string;
  let tmpDir: string;
  let fakeBots: ReturnType<typeof makeFakeBot>[];

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const alice = await users.createUser("alice", "pw-alice", "admin");
    cookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(alice.id).token}`;

    tmpDir = mkdtempSync(join(tmpdir(), "botsettings-"));
    configPath = join(tmpDir, "config.json");
    config = { ...getDefaultConfig(), idleTimeoutMinutes: 15, autoPauseOnEmpty: true };

    fakeBots = [makeFakeBot(), makeFakeBot()];
    const fakeManager = {
      getAllBots: () => fakeBots,
    } as unknown as BotManager;
    const avatarStore = createAvatarStore(tmpDir);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions));
    app.use(
      "/api/bot",
      createBotRouter(fakeManager, config, configPath, pino({ level: "silent" }), botDb, avatarStore),
    );
  });

  afterEach(() => {
    botDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/bot/settings");
    expect(res.status).toBe(401);
  });

  it("GET /settings includes autoPauseOnEmpty reflecting config", async () => {
    const res = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.idleTimeoutMinutes).toBe(15);
    expect(res.body.autoPauseOnEmpty).toBe(true);
  });

  it("POST /settings with autoPauseOnEmpty:false persists and propagates to bots", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ autoPauseOnEmpty: false });
    expect(res.status).toBe(200);

    // in-memory config mutated
    expect(config.autoPauseOnEmpty).toBe(false);

    // propagated to every live bot
    for (const bot of fakeBots) {
      expect(bot.autoPauseCalls).toEqual([false]);
    }

    // follow-up GET reflects the new value
    const followUp = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(followUp.body.autoPauseOnEmpty).toBe(false);
  });

  it("POST /settings still handles idleTimeoutMinutes (no regression)", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ idleTimeoutMinutes: 42 });
    expect(res.status).toBe(200);
    expect(config.idleTimeoutMinutes).toBe(42);
    for (const bot of fakeBots) {
      expect(bot.idleTimeoutCalls).toEqual([42]);
    }
    const followUp = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(followUp.body.idleTimeoutMinutes).toBe(42);
  });

  it("POST /settings handles both fields together", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ idleTimeoutMinutes: 7, autoPauseOnEmpty: false });
    expect(res.status).toBe(200);
    expect(config.idleTimeoutMinutes).toBe(7);
    expect(config.autoPauseOnEmpty).toBe(false);
    for (const bot of fakeBots) {
      expect(bot.idleTimeoutCalls).toEqual([7]);
      expect(bot.autoPauseCalls).toEqual([false]);
    }
  });

  it("POST /settings with only autoPauseOnEmpty does not touch idleTimeout bots", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ autoPauseOnEmpty: false });
    expect(res.status).toBe(200);
    for (const bot of fakeBots) {
      expect(bot.idleTimeoutCalls).toEqual([]);
      expect(bot.autoPauseCalls).toEqual([false]);
    }
  });

  it("POST /settings ignores non-boolean autoPauseOnEmpty without 400", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ idleTimeoutMinutes: 5, autoPauseOnEmpty: "yes" });
    expect(res.status).toBe(200);
    // idleTimeout still applied
    expect(config.idleTimeoutMinutes).toBe(5);
    // autoPause left at its prior value, not propagated
    expect(config.autoPauseOnEmpty).toBe(true);
    for (const bot of fakeBots) {
      expect(bot.autoPauseCalls).toEqual([]);
    }
  });
});
