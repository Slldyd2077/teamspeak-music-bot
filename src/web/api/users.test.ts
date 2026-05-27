import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import pino from "pino";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore, type UserStore } from "../../data/users.js";
import { createSessionStore, type SessionStore } from "../../data/sessions.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createUsersRouter } from "./users.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";

function makeApp(users: UserStore, sessions: SessionStore) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const requireAuth = createRequireAuth(sessions);
  app.use("/api", requireAuth);
  app.use("/api/users", createUsersRouter(users, sessions, pino({ level: "silent" })));
  return app;
}

describe("users router", () => {
  let botDb: BotDatabase;
  let users: UserStore;
  let sessions: SessionStore;
  let app: express.Express;
  let aliceId: string;
  let aliceCookie: string;
  let bobId: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    users = createUserStore(botDb.db);
    sessions = createSessionStore(botDb.db);
    app = makeApp(users, sessions);
    const alice = await users.createUser("alice", "pw-alice");
    aliceId = alice.id;
    aliceCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(alice.id).token}`;
    const bob = await users.createUser("bob", "pw-bob-bob");
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
});
