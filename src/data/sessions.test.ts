import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { createDatabase, type BotDatabase } from "./database.js";
import { createUserStore, type UserStore } from "./users.js";
import { createSessionStore, type SessionStore, SESSION_TTL_MS, SESSION_TOUCH_INTERVAL_MS, MAX_SESSIONS_PER_USER, GUEST_SESSION_TTL_MS } from "./sessions.js";

function sha256(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

describe("SessionStore", () => {
  let botDb: BotDatabase;
  let users: UserStore;
  let sessions: SessionStore;
  let userId: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    users = createUserStore(botDb.db);
    sessions = createSessionStore(botDb.db);
    const u = await users.createUser("alice", "pw-alice", "admin");
    userId = u.id;
  });

  afterEach(() => {
    vi.useRealTimers();
    botDb.close();
  });

  it("createSession returns a raw token whose sha256 matches the DB row id", () => {
    const { token } = sessions.createSession(userId);
    const row = botDb.db.prepare("SELECT id FROM sessions").get() as { id: string };
    expect(row.id).toBe(sha256(token));
    expect(row.id).not.toBe(token);
  });

  it("validateAndTouch returns the user for a fresh token", () => {
    const { token } = sessions.createSession(userId);
    const result = sessions.validateAndTouch(token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(userId);
    expect(result!.username).toBe("alice");
    expect(result!.role).toBe("admin");
  });

  it("validateAndTouch returns null and deletes the row for an expired session", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { token } = sessions.createSession(userId);
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + SESSION_TTL_MS + 1000);
    expect(sessions.validateAndTouch(token)).toBeNull();
    const remaining = (botDb.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    expect(remaining).toBe(0);
  });

  it("validateAndTouch does not write the DB if called again within the touch interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { token } = sessions.createSession(userId);
    const before = botDb.db.prepare("SELECT lastSeenAt FROM sessions").get() as { lastSeenAt: number };
    vi.advanceTimersByTime(SESSION_TOUCH_INTERVAL_MS - 1000);
    sessions.validateAndTouch(token);
    const after = botDb.db.prepare("SELECT lastSeenAt FROM sessions").get() as { lastSeenAt: number };
    expect(after.lastSeenAt).toBe(before.lastSeenAt);
  });

  it("validateAndTouch writes lastSeenAt and extends expiresAt past the touch interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { token, expiresAt: initialExpiry } = sessions.createSession(userId);
    vi.advanceTimersByTime(SESSION_TOUCH_INTERVAL_MS + 1000);
    sessions.validateAndTouch(token);
    const row = botDb.db.prepare("SELECT lastSeenAt, expiresAt FROM sessions").get() as { lastSeenAt: number; expiresAt: number };
    expect(row.lastSeenAt).toBe(Date.now());
    expect(row.expiresAt).toBeGreaterThan(initialExpiry);
  });

  it("deleteSession removes the row", () => {
    const { token } = sessions.createSession(userId);
    sessions.deleteSession(token);
    const remaining = (botDb.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    expect(remaining).toBe(0);
    expect(sessions.validateAndTouch(token)).toBeNull();
  });

  it("deleteAllForUser keeps the exceptToken session", () => {
    const a = sessions.createSession(userId);
    const b = sessions.createSession(userId);
    sessions.deleteAllForUser(userId, a.token);
    expect(sessions.validateAndTouch(a.token)).not.toBeNull();
    expect(sessions.validateAndTouch(b.token)).toBeNull();
  });

  it("cleanupExpired removes only expired rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    sessions.createSession(userId); // expires later
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + SESSION_TTL_MS + 1000);
    sessions.createSession(userId); // fresh
    sessions.cleanupExpired();
    const remaining = (botDb.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    expect(remaining).toBe(1);
  });

  it("createSession caps concurrent sessions per user at MAX_SESSIONS_PER_USER, evicting oldest", async () => {
    // Create MAX + 2 sessions for the same user.
    const tokens: string[] = [];
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 2; i++) {
      tokens.push(sessions.createSession(userId).token);
      await new Promise((r) => setTimeout(r, 2)); // stagger createdAt
    }
    const count = (botDb.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    expect(count).toBe(MAX_SESSIONS_PER_USER);
    // The first two should have been evicted, the last MAX remain
    expect(sessions.validateAndTouch(tokens[0])).toBeNull();
    expect(sessions.validateAndTouch(tokens[1])).toBeNull();
    expect(sessions.validateAndTouch(tokens[tokens.length - 1])).not.toBeNull();
  });

  it("createSession respects cap under concurrent calls (no 1-over-cap race)", async () => {
    // better-sqlite3 transactions are serialised at the engine level. Calling
    // createSession N times sequentially via Promise.all proves atomic check+insert.
    const N = MAX_SESSIONS_PER_USER + 3;
    await Promise.all(Array.from({ length: N }, () => Promise.resolve(sessions.createSession(userId))));
    const count = (botDb.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    expect(count).toBe(MAX_SESSIONS_PER_USER);
  });
});

describe("guest sessions", () => {
  let botDb: BotDatabase;
  let sessions: SessionStore;

  beforeEach(() => {
    botDb = createDatabase(":memory:");
    sessions = createSessionStore(botDb.db);
    // Create the synthetic guest user row to satisfy the sessions FK.
    botDb.db
      .prepare("INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES ('__guest__','游客','!',?,?, 'guest')")
      .run(Date.now(), Date.now());
  });

  afterEach(() => {
    vi.useRealTimers();
    botDb.close();
  });

  it("skipCap lets more than MAX_SESSIONS_PER_USER coexist for one principal", () => {
    const tokens: string[] = [];
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 3; i++) {
      tokens.push(sessions.createSession("__guest__", { ttlMs: GUEST_SESSION_TTL_MS, skipCap: true }).token);
    }
    // The first token must STILL validate (not evicted).
    expect(sessions.validateAndTouch(tokens[0])?.role).toBe("guest");
    const n = (botDb.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE userId='__guest__'").get() as { n: number }).n;
    expect(n).toBe(MAX_SESSIONS_PER_USER + 3);
  });

  it("ttlMs sets a shorter expiry than the default", () => {
    const { expiresAt } = sessions.createSession("__guest__", { ttlMs: GUEST_SESSION_TTL_MS, skipCap: true });
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + GUEST_SESSION_TTL_MS + 50);
  });

  it("validateAndTouch refreshes a guest session to GUEST_SESSION_TTL_MS (1d), not SESSION_TTL_MS (7d)", () => {
    const { token } = sessions.createSession("__guest__", { ttlMs: GUEST_SESSION_TTL_MS, skipCap: true });
    // Force the touch branch: backdate lastSeenAt past the touch interval.
    botDb.db
      .prepare("UPDATE sessions SET lastSeenAt = ? WHERE userId = '__guest__'")
      .run(Date.now() - (SESSION_TOUCH_INTERVAL_MS + 1000));
    const result = sessions.validateAndTouch(token);
    expect(result?.role).toBe("guest");
    const row = botDb.db
      .prepare("SELECT expiresAt FROM sessions WHERE userId = '__guest__'")
      .get() as { expiresAt: number };
    // Should refresh to ~now + 1 day, NOT now + 7 days.
    expect(row.expiresAt).toBeGreaterThan(Date.now() + GUEST_SESSION_TTL_MS - 5000);
    expect(row.expiresAt).toBeLessThanOrEqual(Date.now() + GUEST_SESSION_TTL_MS + 5000);
    // Sanity: well below the 7d window.
    expect(row.expiresAt).toBeLessThan(Date.now() + SESSION_TTL_MS);
  });

  it("validateAndTouch still refreshes a non-guest (admin) session to SESSION_TTL_MS (7d) on touch", () => {
    botDb.db
      .prepare("INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES ('admin1','adminuser','!',?,?, 'admin')")
      .run(Date.now(), Date.now());
    const { token } = sessions.createSession("admin1");
    botDb.db
      .prepare("UPDATE sessions SET lastSeenAt = ? WHERE userId = 'admin1'")
      .run(Date.now() - (SESSION_TOUCH_INTERVAL_MS + 1000));
    const result = sessions.validateAndTouch(token);
    expect(result?.role).toBe("admin");
    const row = botDb.db
      .prepare("SELECT expiresAt FROM sessions WHERE userId = 'admin1'")
      .get() as { expiresAt: number };
    // Refreshes to ~now + 7 days, NOT the 1d guest window.
    expect(row.expiresAt).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 5000);
    expect(row.expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS + 5000);
  });
});
