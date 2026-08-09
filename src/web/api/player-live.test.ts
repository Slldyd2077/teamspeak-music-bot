import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createPlayerRouter } from "./player.js";

describe("POST /api/player/:botId/live", () => {
  it("uses the realtime player path instead of the buffered music path", async () => {
    const play = vi.fn();
    const playLive = vi.fn();
    const player = { stop: vi.fn(), resetFailures: vi.fn(), play, playLive };
    const resetLiveVoiceTelemetry = vi.fn();
    const bot = {
      isConnected: () => true,
      runExclusive: async (operation: () => Promise<void> | void) => operation(),
      getPlayer: () => player,
      getQueueManager: () => ({ clear: vi.fn() }),
      resetLiveVoiceTelemetry,
      emit: vi.fn(),
    };
    const botManager = {
      getBot: (id: string) => (id === "voice-bot" ? bot : undefined),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = {
        id: "admin",
        username: "admin",
        role: "admin",
        capabilities: new Set<string>(),
        bots: "all",
      };
      next();
    });
    app.use("/api/player", createPlayerRouter(botManager as any, pino({ level: "silent" })));

    const response = await request(app)
      .post("/api/player/voice-bot/live")
      .send({ url: "https://relay.example/live/session", title: "S-Live voice" });

    expect(response.status).toBe(200);
    expect(resetLiveVoiceTelemetry).toHaveBeenCalledOnce();
    expect(playLive).toHaveBeenCalledWith("https://relay.example/live/session");
    expect(play).not.toHaveBeenCalled();
  });
});
