import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createPlayerRouter } from "./player.js";
import { SoundEffectReplacedError } from "../../audio/player.js";

type TestUser = {
  id: string;
  username: string;
  role: "admin" | "member";
  capabilities: Set<string>;
  bots: "all" | Set<string>;
};

function createFixture(options: {
  connected?: boolean;
  user?: TestUser;
  playSoundEffect?: ReturnType<typeof vi.fn>;
  trustedOrigin?: string;
} = {}) {
  const playSoundEffect = options.playSoundEffect ?? vi.fn(async () => undefined);
  const player = {
    playSoundEffect,
    stop: vi.fn(),
    resetFailures: vi.fn(),
  };
  const clear = vi.fn();
  const bot = {
    isConnected: () => options.connected ?? true,
    getPlayer: () => player,
    getQueueManager: () => ({ clear }),
    emit: vi.fn(),
  };
  const botManager = {
    getBot: (id: string) => (id === "voice-bot" ? bot : undefined),
  };
  const app = express();
  app.use(express.json());
  if (options.user) {
    app.use((req, _res, next) => {
      (req as any).user = options.user;
      next();
    });
  }
  app.use("/api/player", createPlayerRouter(
    botManager as any,
    pino({ level: "silent" }),
    undefined,
    options.trustedOrigin ?? "https://uploads.example",
  ));
  return { app, bot, clear, player, playSoundEffect };
}

const admin: TestUser = {
  id: "admin",
  username: "admin",
  role: "admin",
  capabilities: new Set(),
  bots: "all",
};
const capabilityUrl =
  `https://uploads.example/api/music/voice/entry-sound/stream/${"a".repeat(48)}`;

describe("POST /api/player/:botId/sound-effect", () => {
  it("requires authentication", async () => {
    const { app, playSoundEffect } = createFixture();

    const response = await request(app)
      .post("/api/player/voice-bot/sound-effect")
      .send({ url: capabilityUrl });

    expect(response.status).toBe(401);
    expect(playSoundEffect).not.toHaveBeenCalled();
  });

  it("reuses player.control and bot access authorization", async () => {
    const member: TestUser = {
      id: "member",
      username: "member",
      role: "member",
      capabilities: new Set(["player.control"]),
      bots: new Set(["voice-bot"]),
    };
    const { app, playSoundEffect } = createFixture({ user: member });

    const response = await request(app)
      .post("/api/player/voice-bot/sound-effect")
      .send({ url: capabilityUrl });

    expect(response.status).toBe(200);
    expect(playSoundEffect).toHaveBeenCalledWith(
      capabilityUrl,
    );
  });

  it("starts only the overlay and leaves primary playback and queue untouched", async () => {
    const { app, bot, clear, player, playSoundEffect } = createFixture({ user: admin });

    const response = await request(app)
      .post("/api/player/voice-bot/sound-effect")
      .send({ url: capabilityUrl });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, soundEffect: true });
    expect(playSoundEffect).toHaveBeenCalledOnce();
    expect(player.stop).not.toHaveBeenCalled();
    expect(player.resetFailures).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(bot.emit).not.toHaveBeenCalled();
  });

  it.each([
    "file:///tmp/entrance.mp3",
    "ftp://uploads.example/entrance.mp3",
    "https://user:secret@uploads.example/entrance.mp3",
    "https://uploads.example/entrance.mp3",
    `${capabilityUrl}?extra=value`,
    `https://other.example/api/music/voice/entry-sound/stream/${"a".repeat(48)}`,
    `http://169.254.169.254/api/music/voice/entry-sound/stream/${"a".repeat(48)}`,
    `https://uploads.example/api/music/voice/entry-sound/stream/${"a".repeat(39)}`,
    "not a url",
  ])("rejects an invalid or unsafe URL: %s", async (url) => {
    const { app, playSoundEffect } = createFixture({ user: admin });

    const response = await request(app)
      .post("/api/player/voice-bot/sound-effect")
      .send({ url });

    expect(response.status).toBe(400);
    expect(playSoundEffect).not.toHaveBeenCalled();
  });

  it("fails closed when the trusted PowerfulTS origin is not configured", async () => {
    const { app, playSoundEffect } = createFixture({
      user: admin,
      trustedOrigin: "",
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await request(app)
        .post("/api/player/voice-bot/sound-effect")
        .send({ url: capabilityUrl });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([503, 503, 503, 503]);
    expect(playSoundEffect).not.toHaveBeenCalled();
  });

  it("rejects a disconnected bot before starting the decoder", async () => {
    const { app, playSoundEffect } = createFixture({ connected: false, user: admin });

    const response = await request(app)
      .post("/api/player/voice-bot/sound-effect")
      .send({ url: capabilityUrl });

    expect(response.status).toBe(409);
    expect(playSoundEffect).not.toHaveBeenCalled();
  });

  it("reports decoder startup failure without stopping primary audio", async () => {
    const playSoundEffect = vi.fn(async () => {
      throw new Error("ffmpeg spawn failed");
    });
    const { app, clear, player } = createFixture({ user: admin, playSoundEffect });

    const response = await request(app)
      .post("/api/player/voice-bot/sound-effect")
      .send({ url: capabilityUrl });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "Sound effect could not be started" });
    expect(player.stop).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("reports an intentionally replaced pending effect as a benign result", async () => {
    const playSoundEffect = vi.fn(async () => {
      throw new SoundEffectReplacedError();
    });
    const { app, player } = createFixture({ user: admin, playSoundEffect });

    const response = await request(app)
      .post("/api/player/voice-bot/sound-effect")
      .send({ url: capabilityUrl });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      soundEffect: false,
      replaced: true,
    });
    expect(player.stop).not.toHaveBeenCalled();
  });

  it("rate-limits repeated decoder starts per user and bot", async () => {
    const { app, playSoundEffect } = createFixture({ user: admin });
    const send = () => request(app)
      .post("/api/player/voice-bot/sound-effect")
      .send({ url: capabilityUrl });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const limited = await send();

    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(playSoundEffect).toHaveBeenCalledTimes(3);
  });
});
