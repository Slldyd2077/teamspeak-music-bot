import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createSessionStore } from "../../data/sessions.js";
import { createApiKeyStore } from "../../data/api-keys.js";
import { createPermissionStore } from "../../data/permissions.js";
import { createRequireAuth } from "./requireAuth.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";

describe("requireAuth middleware", () => {
  let botDb: BotDatabase;
  let app: express.Express;
  let validToken: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const permissions = createPermissionStore(botDb.db);
    const u = await users.createUser("alice", "pw-alice", "admin");
    validToken = sessions.createSession(u.id).token;

    app = express();
    app.use(cookieParser());
    app.use(
      createRequireAuth(sessions, permissions, () => ({
        enabled: true,
        bots: "all",
        permissions: {
          addToQueue: true,
          playNext: true,
          playNow: true,
          skip: true,
          transport: true,
          removeClear: true,
          playMode: true,
          playCollection: true,
        },
      }))
    );
    app.get("/protected", (req, res) => {
      res.json({ ok: true, user: (req as any).user });
    });
  });

  afterEach(() => {
    botDb.close();
  });

  it("rejects requests without a session cookie", async () => {
    const res = await request(app).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthenticated" });
  });

  it("rejects requests with an unknown session cookie", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE_NAME}=garbage`);
    expect(res.status).toBe(401);
  });

  it("allows requests with a valid session cookie and attaches req.user", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${validToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.username).toBe("alice");
    expect(res.body.user.role).toBe("admin");
  });

  it("rolls the cookie max-age forward on successful auth", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${validToken}`);
    expect(res.status).toBe(200);
    const setCookieHeaders = res.headers["set-cookie"];
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : setCookieHeaders ? [setCookieHeaders] : [];
    const refreshed = arr.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(refreshed).toBeDefined();
    expect(refreshed!).toMatch(/Max-Age=\d+/);
  });

  // A guest session is rejected (401) when guest mode is disabled.
  it("rejects a guest session when guest mode is disabled", () => {
    const sessions: any = { validateAndTouch: () => ({ userId: "__guest__", username: "游客", role: "guest" }) };
    const permissions: any = { getCapabilities: () => [], getBotAccess: () => [] };
    const getGuestConfig = () => ({ enabled: false, bots: "all" as const, permissions: {} as any });
    const mw = createRequireAuth(sessions, permissions, getGuestConfig);
    const req: any = { headers: { cookie: "tsmb_session=x" } };
    const res: any = { statusCode: 0, cleared: false, clearCookie() { this.cleared = true; }, status(c: number) { this.statusCode = c; return this; }, json() { return this; }, cookie() {} };
    const next = vi.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches guest permissions when guest mode is enabled", () => {
    const sessions: any = { validateAndTouch: () => ({ userId: "__guest__", username: "游客", role: "guest" }) };
    const permissions: any = { getCapabilities: () => [], getBotAccess: () => [] };
    const perms = { addToQueue: true, playNext: false, playNow: false, skip: false, transport: false, removeClear: false, playMode: false, playCollection: false };
    const getGuestConfig = () => ({ enabled: true, bots: ["bot1"], permissions: perms });
    const mw = createRequireAuth(sessions, permissions, getGuestConfig);
    const req: any = { headers: { cookie: "tsmb_session=x" }, secure: false };
    const res: any = { status() { return this; }, json() { return this; }, cookie() {}, clearCookie() {} };
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.role).toBe("guest");
    expect(req.user.guest.addToQueue).toBe(true);
    expect(req.user.bots instanceof Set && req.user.bots.has("bot1")).toBe(true);
  });
});

describe("requireAuth middleware with API keys", () => {
  let botDb: BotDatabase;
  let app: express.Express;
  let adminKey: string;
  let memberKey: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const permissions = createPermissionStore(botDb.db);
    const apiKeys = createApiKeyStore(botDb.db);
    const admin = await users.createUser("alice", "pw-alice", "admin");
    const member = await users.createUser("bob", "pw-bob", "member");
    permissions.setPermissions(member.id, { capabilities: ["player.control"], bots: ["bot1"] });
    adminKey = apiKeys.create(admin.id, "ci")!.rawKey;
    memberKey = apiKeys.create(member.id, "deploy")!.rawKey;

    app = express();
    app.use(cookieParser());
    app.use(
      createRequireAuth(sessions, permissions, () => ({
        enabled: false,
        bots: "all",
        permissions: {} as any,
      }), apiKeys)
    );
    app.get("/protected", (req, res) => {
      const u: any = (req as any).user;
      res.json({
        ok: true,
        authMethod: (req as any).authMethod,
        user: u
          ? {
              username: u.username,
              role: u.role,
              capabilities: u.capabilities ? [...u.capabilities] : [],
              bots: u.bots === "all" ? "all" : [...(u.bots ?? [])],
            }
          : null,
      });
    });
  });

  afterEach(() => {
    botDb.close();
  });

  it("authenticates a valid X-API-Key header and attaches the owner user", async () => {
    const res = await request(app).get("/protected").set("X-API-Key", adminKey);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.username).toBe("alice");
    expect(res.body.user.role).toBe("admin");
    expect(res.body.authMethod).toBe("api-key");
  });

  it("authenticates an Authorization: Bearer key", async () => {
    const res = await request(app).get("/protected").set("Authorization", `Bearer ${adminKey}`);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("alice");
  });

  it("rejects an unknown key with 401", async () => {
    const res = await request(app).get("/protected").set("X-API-Key", "tsmb_bogus");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid api key" });
  });

  it("ignores the session cookie when a key header is present", async () => {
    // Garbage cookie + valid key → key wins.
    const res = await request(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE_NAME}=garbage`)
      .set("X-API-Key", memberKey);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("bob");
  });

  it("a member key inherits the member's capabilities and bot scope", async () => {
    const res = await request(app).get("/protected").set("X-API-Key", memberKey);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("member");
    expect(res.body.user.capabilities).toContain("player.control");
    expect(res.body.user.bots).toContain("bot1");
    expect(res.body.user.capabilities).not.toContain("bot.manage");
  });

  it("returns 401 when a key header is present but no store is wired", async () => {
    const sessions: any = { validateAndTouch: () => null };
    const permissions: any = { getCapabilities: () => [], getBotAccess: () => [] };
    const mw = createRequireAuth(sessions, permissions, () => ({ enabled: false, bots: "all", permissions: {} as any }));
    const req: any = { headers: { "x-api-key": "tsmb_x" } };
    const res: any = { status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
    const next = vi.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("a key whose owner was deleted stops working", async () => {
    const users = createUserStore(botDb.db);
    const member = users.findByUsername("bob")!;
    users.deleteUser(member.id);
    const res = await request(app).get("/protected").set("X-API-Key", memberKey);
    expect(res.status).toBe(401);
  });
});
