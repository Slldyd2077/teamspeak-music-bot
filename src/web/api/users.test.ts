import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import pino from "pino";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore, GUEST_USER_ID, type UserStore } from "../../data/users.js";
import { createSessionStore, type SessionStore } from "../../data/sessions.js";
import { createAuditStore, type AuditStore } from "../../data/audit.js";
import { createPermissionStore, type PermissionStore } from "../../data/permissions.js";
import { getDefaultConfig } from "../../data/config.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createUsersRouter } from "./users.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";

function makeApp(botDb: BotDatabase, users: UserStore, sessions: SessionStore) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const permissions = createPermissionStore(botDb.db);
  const requireAuth = createRequireAuth(sessions, permissions, () => getDefaultConfig().guestMode);
  const audit = createAuditStore(botDb.db);
  app.use("/api", requireAuth);
  app.use("/api/users", createUsersRouter(users, sessions, audit, pino({ level: "silent" }), permissions));
  return { app, permissions, audit };
}

describe("users router", () => {
  let botDb: BotDatabase;
  let users: UserStore;
  let sessions: SessionStore;
  let app: express.Express;
  let permissions: PermissionStore;
  let audit: AuditStore;
  let aliceId: string;
  let aliceCookie: string;
  let bobId: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    users = createUserStore(botDb.db);
    sessions = createSessionStore(botDb.db);
    ({ app, permissions, audit } = makeApp(botDb, users, sessions));
    const alice = await users.createUser("alice", "pw-alice", "admin");
    aliceId = alice.id;
    aliceCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(alice.id).token}`;
    const bob = await users.createUser("bob", "pw-bob-bob", "member");
    bobId = bob.id;
  });

  afterEach(() => botDb.close());

  it("requires auth for all routes", async () => {
    expect((await request(app).get("/api/users")).status).toBe(401);
    expect((await request(app).post("/api/users").send({ username: "x", password: "yyyyyyyy" })).status).toBe(401);
    expect((await request(app).delete(`/api/users/${bobId}`)).status).toBe(401);
  });

  it("GET / lists users with id+username+createdAt, no password hash", async () => {
    const res = await request(app).get("/api/users").set("Cookie", aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    for (const u of res.body.users) {
      expect(u).toHaveProperty("id");
      expect(u).toHaveProperty("username");
      expect(u).toHaveProperty("createdAt");
      expect(u).not.toHaveProperty("passwordHash");
    }
  });

  it("POST / creates a user", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("Cookie", aliceCookie)
      .send({ username: "charlie", password: "charlie-pw" });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe("charlie");
    expect(users.countUsers()).toBe(3);
  });

  it("POST / returns 409 on duplicate username", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("Cookie", aliceCookie)
      .send({ username: "BOB", password: "another-pw" });
    expect(res.status).toBe(409);
  });

  it("POST / returns 400 on invalid input", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("Cookie", aliceCookie)
      .send({ username: "x", password: "short" });
    expect(res.status).toBe(400);
  });

  it("DELETE /:id removes the user and their sessions", async () => {
    const bobToken = sessions.createSession(bobId).token;
    const res = await request(app).delete(`/api/users/${bobId}`).set("Cookie", aliceCookie);
    expect(res.status).toBe(204);
    expect(users.countUsers()).toBe(1);
    expect(sessions.validateAndTouch(bobToken)).toBeNull();
  });

  it("DELETE /:id of self returns 400", async () => {
    const res = await request(app).delete(`/api/users/${aliceId}`).set("Cookie", aliceCookie);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "cannot delete self" });
    expect(users.countUsers()).toBe(2);
  });

  it("DELETE /:id of nonexistent returns 404", async () => {
    const res = await request(app).delete(`/api/users/not-a-real-id`).set("Cookie", aliceCookie);
    expect(res.status).toBe(404);
  });

  it("POST /:id/reset-password updates the hash and invalidates target's sessions", async () => {
    const bobToken = sessions.createSession(bobId).token;
    const res = await request(app)
      .post(`/api/users/${bobId}/reset-password`)
      .set("Cookie", aliceCookie)
      .send({ newPassword: "bob-new-pw" });
    expect(res.status).toBe(204);
    expect(sessions.validateAndTouch(bobToken)).toBeNull();
    const bob = users.findByUsername("bob");
    expect(await users.verifyPassword("bob-new-pw", bob!.passwordHash)).toBe(true);
    expect(await users.verifyPassword("pw-bob-bob", bob!.passwordHash)).toBe(false);
  });

  it("POST /:id/reset-password 404 on unknown user", async () => {
    const res = await request(app)
      .post(`/api/users/not-a-real-id/reset-password`)
      .set("Cookie", aliceCookie)
      .send({ newPassword: "anything-here" });
    expect(res.status).toBe(404);
  });

  it("POST /:id/reset-password 400 on short password", async () => {
    const res = await request(app)
      .post(`/api/users/${bobId}/reset-password`)
      .set("Cookie", aliceCookie)
      .send({ newPassword: "short" });
    expect(res.status).toBe(400);
  });

  it("returns 201 even if audit insert fails (POST /api/users)", async () => {
    // Build a broken audit store that throws on record()
    const brokenAudit = {
      record: () => { throw new Error("simulated disk-full"); },
      list: () => [],
    };
    // Reassemble app with the broken audit
    const localApp = express();
    localApp.use(express.json());
    localApp.use(cookieParser());
    localApp.use("/api", createRequireAuth(sessions, createPermissionStore(botDb.db), () => getDefaultConfig().guestMode));
    localApp.use(
      "/api/users",
      createUsersRouter(users, sessions, brokenAudit, pino({ level: "silent" }), createPermissionStore(botDb.db))
    );
    const res = await request(localApp)
      .post("/api/users")
      .set("Cookie", aliceCookie)
      .send({ username: "charlie", password: "charlie-pw" });
    expect(res.status).toBe(201);
    expect(users.countUsers()).toBe(3);
  });

  it("POST /:id/reset-password on self preserves the actor's current session", async () => {
    // Alice resets her OWN password
    const res = await request(app)
      .post(`/api/users/${aliceId}/reset-password`)
      .set("Cookie", aliceCookie)
      .send({ newPassword: "alice-new-pw" });
    expect(res.status).toBe(204);

    // Alice's CURRENT session should still work
    // (we'd need a protected endpoint to verify; use GET /api/users which is already mounted)
    const followUp = await request(app).get("/api/users").set("Cookie", aliceCookie);
    expect(followUp.status).toBe(200);

    // The password hash IS updated (sanity check)
    const alice = users.findById(aliceId);
    expect(await users.verifyPassword("alice-new-pw", alice!.passwordHash)).toBe(true);
  });

  it("POST /:id/reset-password on another user does NOT preserve any of target's sessions", async () => {
    const bobToken = sessions.createSession(bobId).token;
    const res = await request(app)
      .post(`/api/users/${bobId}/reset-password`)
      .set("Cookie", aliceCookie)
      .send({ newPassword: "bob-new-pw" });
    expect(res.status).toBe(204);
    // Bob's session should be dead
    expect(sessions.validateAndTouch(bobToken)).toBeNull();
  });

  it("POST / defaults new user to role=member when role omitted", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("Cookie", aliceCookie)
      .send({ username: "carol", password: "pw-carol-pw" });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("member");
  });

  it("POST / accepts role=admin", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("Cookie", aliceCookie)
      .send({ username: "carol", password: "pw-carol-pw", role: "admin" });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("admin");
    expect(users.countAdmins()).toBe(2);
  });

  it("PATCH /:id/role can change role between admin and member", async () => {
    const res = await request(app)
      .patch(`/api/users/${bobId}/role`)
      .set("Cookie", aliceCookie)
      .send({ role: "admin" });
    expect(res.status).toBe(204);
    expect(users.findById(bobId)!.role).toBe("admin");
  });

  it("PATCH /:id/role blocks demoting the last admin", async () => {
    // alice is the only admin. Demoting her would leave 0 admins. Block.
    const res = await request(app)
      .patch(`/api/users/${aliceId}/role`)
      .set("Cookie", aliceCookie)
      .send({ role: "member" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "cannot demote last admin" });
  });

  it("PATCH /:id/role allows demoting an admin when other admins exist", async () => {
    // Promote bob first
    users.setRole(bobId, "admin");
    // Now both are admins. Demoting alice should work.
    const res = await request(app)
      .patch(`/api/users/${aliceId}/role`)
      .set("Cookie", aliceCookie)
      .send({ role: "member" });
    expect(res.status).toBe(204);
  });

  it("PATCH /:id/role 400 on invalid role", async () => {
    const res = await request(app)
      .patch(`/api/users/${bobId}/role`)
      .set("Cookie", aliceCookie)
      .send({ role: "superuser" });
    expect(res.status).toBe(400);
  });

  it("PATCH /:id/role 404 on unknown user", async () => {
    const res = await request(app)
      .patch(`/api/users/not-a-real-id/role`)
      .set("Cookie", aliceCookie)
      .send({ role: "admin" });
    expect(res.status).toBe(404);
  });

  it("GET /:id/permissions returns empty arrays for a fresh member", async () => {
    const res = await request(app)
      .get(`/api/users/${bobId}/permissions`)
      .set("Cookie", aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ capabilities: [], bots: [] });
  });

  it("GET /:id/permissions 404 on unknown user", async () => {
    const res = await request(app)
      .get(`/api/users/not-a-real-id/permissions`)
      .set("Cookie", aliceCookie);
    expect(res.status).toBe(404);
  });

  it("PUT /:id/permissions sets permissions, persists, and audits", async () => {
    const before = audit.list(100, 0).filter((e) => e.action === "user.permissions_changed");
    expect(before).toHaveLength(0);

    const put = await request(app)
      .put(`/api/users/${bobId}/permissions`)
      .set("Cookie", aliceCookie)
      .send({ capabilities: ["player.control"], bots: "all" });
    expect(put.status).toBe(200);

    const get = await request(app)
      .get(`/api/users/${bobId}/permissions`)
      .set("Cookie", aliceCookie);
    expect(get.status).toBe(200);
    expect(get.body).toEqual({ capabilities: ["player.control"], bots: "all" });

    const rows = audit.list(100, 0).filter((e) => e.action === "user.permissions_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(aliceId);
    expect(rows[0].targetUserId).toBe(bobId);
  });

  it("PUT /:id/permissions drops unknown capability tokens", async () => {
    const put = await request(app)
      .put(`/api/users/${bobId}/permissions`)
      .set("Cookie", aliceCookie)
      .send({ capabilities: ["player.control", "bogus"], bots: [] });
    expect(put.status).toBe(200);
    expect(permissions.getCapabilities(bobId)).toEqual(["player.control"]);
  });

  it("PUT /:id/permissions 404 on unknown user", async () => {
    const res = await request(app)
      .put(`/api/users/not-a-real-id/permissions`)
      .set("Cookie", aliceCookie)
      .send({ capabilities: ["player.control"], bots: "all" });
    expect(res.status).toBe(404);
  });

  it("POST / seeds the basic tier for a new member", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("Cookie", aliceCookie)
      .send({ username: "dave", password: "dave-pw-pw" });
    expect(res.status).toBe(201);
    const perms = await request(app)
      .get(`/api/users/${res.body.id}/permissions`)
      .set("Cookie", aliceCookie);
    expect(perms.status).toBe(200);
    expect(perms.body).toEqual({
      capabilities: ["player.control", "player.queue"],
      bots: "all",
    });
  });

  it("POST / does NOT seed permissions for a new admin", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("Cookie", aliceCookie)
      .send({ username: "erin", password: "erin-pw-pw", role: "admin" });
    expect(res.status).toBe(201);
    const perms = await request(app)
      .get(`/api/users/${res.body.id}/permissions`)
      .set("Cookie", aliceCookie);
    expect(perms.status).toBe(200);
    expect(perms.body).toEqual({ capabilities: [], bots: [] });
  });

  // --- reserved guest principal is never mutable/visible via user mgmt -------
  // The synthetic __guest__ row is seeded by createDatabase. findById has no
  // role filter, so without the 404-guard these by-id handlers would operate
  // on it (privilege-escalation / DoS / cred-login holes).
  describe("reserved __guest__ principal is 404 on every by-id handler", () => {
    it("DELETE /:id → 404 and the guest row survives", async () => {
      const res = await request(app).delete(`/api/users/${GUEST_USER_ID}`).set("Cookie", aliceCookie);
      expect(res.status).toBe(404);
      expect(users.findById(GUEST_USER_ID)).not.toBeNull();
      expect(users.findById(GUEST_USER_ID)!.role).toBe("guest");
    });

    it("PATCH /:id/role {role:'admin'} → 404 and the guest role is unchanged", async () => {
      const res = await request(app)
        .patch(`/api/users/${GUEST_USER_ID}/role`)
        .set("Cookie", aliceCookie)
        .send({ role: "admin" });
      expect(res.status).toBe(404);
      expect(users.findById(GUEST_USER_ID)!.role).toBe("guest");
    });

    it("POST /:id/reset-password → 404 (cannot give the guest a login)", async () => {
      const res = await request(app)
        .post(`/api/users/${GUEST_USER_ID}/reset-password`)
        .set("Cookie", aliceCookie)
        .send({ newPassword: "guest-new-pw" });
      expect(res.status).toBe(404);
    });

    it("GET /:id/permissions → 404", async () => {
      const res = await request(app)
        .get(`/api/users/${GUEST_USER_ID}/permissions`)
        .set("Cookie", aliceCookie);
      expect(res.status).toBe(404);
    });

    it("PUT /:id/permissions → 404", async () => {
      const res = await request(app)
        .put(`/api/users/${GUEST_USER_ID}/permissions`)
        .set("Cookie", aliceCookie)
        .send({ capabilities: ["player.control"], bots: "all" });
      expect(res.status).toBe(404);
    });
  });
});
