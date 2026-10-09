import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createDatabase } from "../../data/database.js";
import { createPersonalMusicRouter } from "./personal-music.js";
import { createPlayerRouter } from "./player.js";

function mount() {
  const db = createDatabase(":memory:");
  db.db
    .prepare("INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES (?,?,?,?,?,?)")
    .run("u1", "alice", "x", 0, 0, "member");
  const personalView = {
    getAuthStatus: vi.fn(async () => ({ loggedIn: true, nickname: "Alice163" })),
  };
  const provider: any = {
    platform: "netease",
    getQrCode: vi.fn(async () => ({ qrUrl: "u", qrImg: "data:img", key: "k1" })),
    pollQrLogin: vi.fn(async () => ({ status: "waiting" })),
    withCookie: vi.fn(() => personalView),
    setCookie: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: "u1", username: "alice", role: "member" };
    next();
  });
  app.use("/api/me/music", createPersonalMusicRouter(db, provider, pino({ level: "silent" })));
  return { app, db, provider, personalView };
}

describe("personal music account router (#164)", () => {
  it("reports not linked until the user logs in", async () => {
    const { app } = mount();
    const res = await request(app).get("/api/me/music/netease/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linked: false, loggedIn: false });
  });

  it("creates a QR code", async () => {
    const { app } = mount();
    const res = await request(app).post("/api/me/music/netease/qrcode");
    expect(res.body).toEqual({ qrUrl: "u", qrImg: "data:img", key: "k1" });
  });

  it("stores the cookie for this user on confirm, never on the shared provider, and never returns it", async () => {
    const { app, db, provider } = mount();
    provider.pollQrLogin.mockResolvedValue({ status: "confirmed", cookie: "MUSIC_U=alice" });
    const res = await request(app).get("/api/me/music/netease/qrcode/status").query({ key: "k1" });
    expect(res.body).toEqual({ status: "confirmed" });
    expect(JSON.stringify(res.body)).not.toContain("MUSIC_U");
    expect(db.getUserMusicCookie("u1", "netease")).toBe("MUSIC_U=alice");
    expect(provider.setCookie).not.toHaveBeenCalled();
  });

  it("requires a key to poll", async () => {
    const { app } = mount();
    expect((await request(app).get("/api/me/music/netease/qrcode/status")).status).toBe(400);
  });

  it("reports the linked account's nickname via a view on the user's cookie", async () => {
    const { app, db, provider } = mount();
    db.setUserMusicCookie("u1", "netease", "MUSIC_U=alice");
    const res = await request(app).get("/api/me/music/netease/status");
    expect(res.body).toEqual({ linked: true, loggedIn: true, nickname: "Alice163" });
    expect(provider.withCookie).toHaveBeenCalledWith("MUSIC_U=alice");
  });

  it("unlinks", async () => {
    const { app, db } = mount();
    db.setUserMusicCookie("u1", "netease", "MUSIC_U=alice");
    expect((await request(app).delete("/api/me/music/netease")).status).toBe(200);
    expect(db.getUserMusicCookie("u1", "netease")).toBeNull();
  });
});

describe("web FM uses the caller's linked NetEase account (#164)", () => {
  async function startFm(opts: { linked: boolean; role?: string; platform?: string }) {
    const db = createDatabase(":memory:");
    db.db
      .prepare("INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES (?,?,?,?,?,?)")
      .run("u1", "alice", "x", 0, 0, "member");
    if (opts.linked) db.setUserMusicCookie("u1", "netease", "MUSIC_U=alice");
    const personal = { platform: "netease", personal: true };
    const shared: any = { platform: "netease", pollQrLogin: vi.fn(), withCookie: vi.fn(() => personal) };
    const qq: any = { platform: "qq" };
    const bot = {
      id: "b1",
      getProviderFor: (p: string) => (p === "qq" ? qq : shared),
      startFm: vi.fn(async (_provider: unknown) => "Personal FM started"),
    };
    const botManager: any = { getBot: () => bot };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = {
        id: "u1", username: "alice", role: opts.role ?? "member",
        capabilities: new Set(["player.control"]), bots: "all", guest: { playMode: true },
      };
      next();
    });
    app.use("/api/player", createPlayerRouter(botManager, pino({ level: "silent" }), db));
    const res = await request(app).post("/api/player/b1/fm").send({ platform: opts.platform ?? "netease" });
    return { res, bot, shared, personal, qq };
  }

  it("starts FM on the user's own account when linked", async () => {
    const { res, bot, shared, personal } = await startFm({ linked: true });
    expect(res.status).toBe(200);
    expect(shared.withCookie).toHaveBeenCalledWith("MUSIC_U=alice");
    expect(bot.startFm.mock.calls[0][0]).toBe(personal);
  });

  it("falls back to the shared account when the user has not linked one", async () => {
    const { bot, shared } = await startFm({ linked: false });
    expect(bot.startFm.mock.calls[0][0]).toBe(shared);
  });

  it("leaves other platforms alone", async () => {
    const { bot, qq } = await startFm({ linked: true, platform: "qq" });
    expect(bot.startFm.mock.calls[0][0]).toBe(qq);
  });
});
