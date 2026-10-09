import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createSessionStore, type SessionStore } from "../../data/sessions.js";
import { createAuditStore, type AuditStore } from "../../data/audit.js";
import { createApiKeyStore, MAX_API_KEYS_PER_USER, type ApiKeyStore } from "../../data/api-keys.js";
import { createPermissionStore } from "../../data/permissions.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createApiKeysRouter } from "./api-keys.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";

describe("api-keys router", () => {
  let botDb: BotDatabase;
  let app: express.Express;
  let sessions: SessionStore;
  let apiKeys: ApiKeyStore;
  let audit: AuditStore;
  let adminId: string;
  let memberId: string;
  let adminToken: string;
  let memberToken: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    sessions = createSessionStore(botDb.db);
    audit = createAuditStore(botDb.db);
    const permissions = createPermissionStore(botDb.db);
    apiKeys = createApiKeyStore(botDb.db);
    const admin = await users.createUser("alice", "pw-alice", "admin");
    const member = await users.createUser("bob", "pw-bob", "member");
    adminId = admin.id;
    memberId = member.id;
    adminToken = sessions.createSession(adminId).token;
    memberToken = sessions.createSession(memberId).token;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(
      createRequireAuth(sessions, permissions, () => ({
        enabled: false,
        bots: "all",
        permissions: {} as any,
      }), apiKeys)
    );
    app.use("/api/keys", createApiKeysRouter(apiKeys, audit, { info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) } as any));
  });

  afterEach(() => {
    botDb.close();
  });

  const authed = (token: string) => {
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    return {
      get: (url: string) => request(app).get(url).set("Cookie", cookie),
      post: (url: string) => request(app).post(url).set("Cookie", cookie),
      delete: (url: string) => request(app).delete(url).set("Cookie", cookie),
    };
  };
  const asAdmin = () => authed(adminToken);
  const asMember = () => authed(memberToken);

  it("lists only the caller's own keys", async () => {
    apiKeys.create(adminId, "mine");
    apiKeys.create(memberId, "theirs");
    const res = await asAdmin().get("/api/keys");
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0].name).toBe("mine");
    expect(res.body.keys[0].rawKey).toBeUndefined();
  });

  it("creates a key and returns the plaintext exactly once", async () => {
    const res = await asAdmin().post("/api/keys").send({ name: "ci" });
    expect(res.status).toBe(201);
    expect(res.body.rawKey).toMatch(/^tsmb_/);
    expect(apiKeys.validateAndTouch(res.body.rawKey)?.userId).toBe(adminId);
    // The list view never exposes the plaintext again.
    const list = await asAdmin().get("/api/keys");
    expect(JSON.stringify(list.body)).not.toContain(res.body.rawKey);
  });

  it("rejects creation without a valid name", async () => {
    expect((await asAdmin().post("/api/keys").send({})).status).toBe(400);
    expect((await asAdmin().post("/api/keys").send({ name: "" })).status).toBe(400);
    expect((await asAdmin().post("/api/keys").send({ name: "x".repeat(65) })).status).toBe(400);
  });

  it("rejects creation beyond the per-user cap with 409", async () => {
    for (let i = 0; i < MAX_API_KEYS_PER_USER; i++) {
      apiKeys.create(memberId, `k${i}`);
    }
    const res = await asMember().post("/api/keys").send({ name: "overflow" });
    expect(res.status).toBe(409);
  });

  it("deletes own key and it stops validating", async () => {
    const { key } = apiKeys.create(memberId, "ci")!;
    const res = await asMember().delete(`/api/keys/${key.id}`);
    expect(res.status).toBe(200);
    expect(apiKeys.listForUser(memberId)).toHaveLength(0);
  });

  it("a member cannot delete another user's key", async () => {
    const { key } = apiKeys.create(adminId, "admin-key")!;
    const res = await asMember().delete(`/api/keys/${key.id}`);
    expect(res.status).toBe(404);
    expect(apiKeys.listForUser(adminId)).toHaveLength(1);
  });

  it("an admin revoking another user's key audits that key's owner", async () => {
    const { key } = apiKeys.create(memberId, "member-key")!;
    const res = await asAdmin().delete(`/api/keys/${key.id}`);
    expect(res.status).toBe(200);
    expect(apiKeys.listForUser(memberId)).toHaveLength(0);
    expect(audit.list(10, 0)).toEqual([
      expect.objectContaining({
        actorId: adminId,
        actorUsername: "alice",
        targetUserId: memberId,
        targetUsername: "bob",
        action: "api_key.deleted",
      }),
    ]);
  });

  it("admin can list all keys with ?all=1, members cannot", async () => {
    apiKeys.create(adminId, "a");
    apiKeys.create(memberId, "b");
    const adminAll = await asAdmin().get("/api/keys?all=1");
    expect(adminAll.body.keys).toHaveLength(2);
    expect(adminAll.body.keys.map((k: any) => k.username).sort()).toEqual(["alice", "bob"]);
    const memberAll = await asMember().get("/api/keys?all=1");
    expect(memberAll.body.keys).toHaveLength(1);
    expect(memberAll.body.keys[0].name).toBe("b");
  });

  it("a request authenticated by an API key cannot manage keys", async () => {
    const { rawKey } = apiKeys.create(adminId, "self-mgmt")!;
    const res = await request(app)
      .post("/api/keys")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ name: "proliferate" });
    expect(res.status).toBe(403);
  });

  it("requires authentication", async () => {
    expect((await request(app).get("/api/keys")).status).toBe(401);
  });
});
