import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createBotRouter } from "./bot.js";

const logger = pino({ level: "silent" });

// Fake bot whose getStatus() exposes its id, matching the real status shape.
function makeFakeBot(id: string) {
  return {
    id,
    getStatus: () => ({ id }),
  };
}

function makeBotManager() {
  const b1 = makeFakeBot("b1");
  const b2 = makeFakeBot("b2");
  return {
    getBot: (id: string) => (id === "b1" ? b1 : id === "b2" ? b2 : undefined),
    getAllBots: () => [b1, b2],
    getBotConfig: () => undefined,
    createBot: async () => b1,
    updateBot: () => {},
    removeBot: async () => {},
    startBot: async () => {},
    stopBot: () => {},
  } as any;
}

function makeApp(user: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = user; next(); });
  app.use(
    "/api/bot",
    createBotRouter(
      makeBotManager(),
      { idleTimeoutMinutes: 0 } as any,
      "/tmp/config.json",
      logger,
      { getBotInstances: () => [], getCustomAvatarPath: () => null, setCustomAvatarPath: () => {} } as any,
      { read: () => null, write: () => "x", remove: () => {} } as any,
    ),
  );
  return app;
}

const member = (bots: "all" | string[]) => ({
  id: "u1",
  username: "alice",
  role: "member" as const,
  capabilities: new Set<string>(),
  bots: bots === "all" ? ("all" as const) : new Set(bots),
});

const admin = {
  id: "a",
  username: "admin",
  role: "admin" as const,
  capabilities: new Set<string>(),
  bots: "all" as const,
};

describe("GET /api/bot bot-list filtering", () => {
  it("member with bots:Set([b1]) sees only b1", async () => {
    const app = makeApp(member(["b1"]));
    const res = await request(app).get("/api/bot");
    expect(res.status).toBe(200);
    const ids = (res.body.bots as { id: string }[]).map((b) => b.id);
    expect(ids).toEqual(["b1"]);
  });

  it("admin sees both b1 and b2", async () => {
    const app = makeApp(admin);
    const res = await request(app).get("/api/bot");
    expect(res.status).toBe(200);
    const ids = (res.body.bots as { id: string }[]).map((b) => b.id).sort();
    expect(ids).toEqual(["b1", "b2"]);
  });

  it("member with bots:'all' sees both b1 and b2", async () => {
    const app = makeApp(member("all"));
    const res = await request(app).get("/api/bot");
    expect(res.status).toBe(200);
    const ids = (res.body.bots as { id: string }[]).map((b) => b.id).sort();
    expect(ids).toEqual(["b1", "b2"]);
  });
});
