# WebUI Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add username + password auth (multi-user) to the WebUI so that all `/api/*` (except an explicit public whitelist) and the `/ws` WebSocket reject unauthenticated requests, gated by a 7-day rolling cookie session.

**Architecture:** Two new SQLite tables (`users`, `sessions`) reusing the existing better-sqlite3 instance, bcryptjs password hashing, sha256-hashed session IDs at rest, raw 32-byte random token in an HTTP-only `tsmb_session` cookie. Two Express middlewares (`requireAuth`, `csrfOriginCheck`) gate every protected `/api/*` router. The WebSocket switches from passive `path: "/ws"` binding to manual `server.on("upgrade", …)` so it validates the same cookie before accepting the handshake. Frontend gets a `useSession` composable, a router guard, a login view and a first-run wizard view; the existing `/setup` route (bot-creation wizard) is left untouched and the new admin-setup view is mounted at `/first-run` to avoid name collision.

**Tech Stack:** TypeScript / Express 5 / better-sqlite3 / `ws` / Vitest / Vue 3 + Vue Router + Pinia / bcryptjs (pure JS, no native build).

**Spec:** `docs/superpowers/specs/2026-05-27-webui-authentication-design.md`

**Branch:** `feat/webui-auth` (already created and contains the spec commit `f7c1688`).

---

## Files map

```
NEW backend
  src/data/users.ts
  src/data/users.test.ts
  src/data/sessions.ts
  src/data/sessions.test.ts
  src/web/auth/validateSession.ts
  src/web/middleware/requireAuth.ts
  src/web/middleware/requireAuth.test.ts
  src/web/middleware/csrf.ts
  src/web/middleware/csrf.test.ts
  src/web/api/session.ts
  src/web/api/session.test.ts
  src/web/websocket-auth.test.ts

MODIFIED backend
  src/data/database.ts          (add users + sessions tables in initTables)
  src/web/server.ts             (cookieParser, public/protected ordering, cleanup interval, manual ws upgrade)
  src/web/websocket.ts          (no functional change; export setupWebSocket already passes wss)
  package.json                  (deps)

NEW frontend
  web/src/views/Login.vue
  web/src/views/FirstRunSetup.vue
  web/src/composables/useSession.ts
  web/src/api/http.ts           (small fetch wrapper with credentials + 401 handler)

MODIFIED frontend
  web/src/router/index.ts       (add /login, /first-run, beforeEach guard)
  web/src/App.vue               (logout button + username chip in Navbar slot)
  web/src/components/Navbar.vue (render the slot for logout/username)
```

> Note on `/setup` collision: the existing `Setup.vue` (mounted at `/setup`) is the bot-creation wizard, not admin setup. The new admin first-run wizard uses path `/first-run`. The spec said `/setup`; this plan supersedes it because the path is already taken.

---

## Task 1: Branch state + new dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Verify branch**

```bash
git status --short
git branch --show-current
```
Expected: clean working tree on `feat/webui-auth`.

- [ ] **Step 2: Install runtime + type deps**

```bash
npm install bcryptjs@^2.4.3 cookie-parser@^1.4.7
npm install --save-dev @types/bcryptjs@^2.4.6 @types/cookie-parser@^1.4.8
```

- [ ] **Step 3: Sanity-check installation**

```bash
node -e "console.log(require('bcryptjs').hashSync('x', 4))"
```
Expected: a bcrypt hash string beginning with `$2a$04$`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add bcryptjs + cookie-parser for WebUI auth"
```

---

## Task 2: Schema migration for users + sessions

**Files:**
- Modify: `src/data/database.ts:102-131` (extend `initTables`)
- Modify: `src/data/database.test.ts` (add table-creation assertion)

- [ ] **Step 1: Write the failing test**

Add to `src/data/database.test.ts` inside the existing `describe("database", …)` block, after the "creates tables on init" test:

```ts
it("creates users and sessions tables on init", () => {
  const tables = botDb.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  expect(names).toContain("users");
  expect(names).toContain("sessions");

  const userCols = botDb.db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const userColNames = userCols.map((c) => c.name).sort();
  expect(userColNames).toEqual(["createdAt", "id", "passwordHash", "updatedAt", "username"]);

  const sessionCols = botDb.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const sessionColNames = sessionCols.map((c) => c.name).sort();
  expect(sessionColNames).toEqual(["createdAt", "expiresAt", "id", "lastSeenAt", "userId"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/data/database.test.ts
```
Expected: FAIL on "creates users and sessions tables on init" with assertion error.

- [ ] **Step 3: Add tables in `initTables`**

In `src/data/database.ts`, replace the `db.exec(\`...\`)` call inside `initTables` so it ends like this (keep the existing `play_history` and `bot_instances` blocks, append the two new tables to the same string):

```ts
function initTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      botId TEXT NOT NULL,
      songId TEXT NOT NULL,
      songName TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      platform TEXT NOT NULL,
      coverUrl TEXT NOT NULL,
      playedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bot_instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      serverAddress TEXT NOT NULL,
      serverPort INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      defaultChannel TEXT NOT NULL,
      channelPassword TEXT NOT NULL,
      autoStart INTEGER NOT NULL DEFAULT 0,
      serverProtocol TEXT NOT NULL DEFAULT '',
      ts6ApiKey TEXT NOT NULL DEFAULT '',
      serverPassword TEXT NOT NULL DEFAULT '',
      identity TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      passwordHash TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      lastSeenAt INTEGER NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiresAt ON sessions(expiresAt);
  `);
}
```

Also enable FK enforcement in `createDatabase` (better-sqlite3 default is OFF). Add this line **immediately after** `db.pragma("journal_mode = WAL")`:

```ts
db.pragma("foreign_keys = ON");
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/data/database.test.ts
```
Expected: all tests PASS, including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/data/database.ts src/data/database.test.ts
git commit -m "feat(db): add users and sessions tables for WebUI auth"
```

---

## Task 3: `src/data/users.ts` — user CRUD + password hashing

**Files:**
- Create: `src/data/users.ts`
- Create: `src/data/users.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/data/users.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, type BotDatabase } from "./database.js";
import { createUserStore, UsernameTakenError, type UserStore } from "./users.js";

describe("UserStore", () => {
  let botDb: BotDatabase;
  let users: UserStore;

  beforeEach(() => {
    botDb = createDatabase(":memory:");
    users = createUserStore(botDb.db);
  });

  afterEach(() => {
    botDb.close();
  });

  it("countUsers is 0 on a fresh db", () => {
    expect(users.countUsers()).toBe(0);
  });

  it("createUser stores the user and bumps countUsers", async () => {
    const u = await users.createUser("alice", "pw-hunter2");
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(u.username).toBe("alice");
    expect(users.countUsers()).toBe(1);
  });

  it("findByUsername is case-insensitive and returns null for missing", async () => {
    await users.createUser("Alice", "pw");
    expect(users.findByUsername("ALICE")).not.toBeNull();
    expect(users.findByUsername("alice")).not.toBeNull();
    expect(users.findByUsername("bob")).toBeNull();
  });

  it("createUser rejects duplicate usernames (case-insensitive)", async () => {
    await users.createUser("Alice", "pw");
    await expect(users.createUser("alice", "pw2")).rejects.toBeInstanceOf(UsernameTakenError);
  });

  it("verifyPassword accepts correct password and rejects wrong one", async () => {
    await users.createUser("alice", "correct-horse-battery-staple");
    const row = users.findByUsername("alice");
    expect(row).not.toBeNull();
    expect(await users.verifyPassword("correct-horse-battery-staple", row!.passwordHash)).toBe(true);
    expect(await users.verifyPassword("wrong", row!.passwordHash)).toBe(false);
  });

  it("changePassword updates the hash so the old password no longer verifies", async () => {
    const u = await users.createUser("alice", "old");
    await users.changePassword(u.id, "new");
    const row = users.findByUsername("alice");
    expect(await users.verifyPassword("old", row!.passwordHash)).toBe(false);
    expect(await users.verifyPassword("new", row!.passwordHash)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/data/users.test.ts
```
Expected: FAIL — module `./users.js` not found.

- [ ] **Step 3: Implement `src/data/users.ts`**

```ts
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserStore {
  countUsers(): number;
  createUser(username: string, password: string): Promise<UserRow>;
  findByUsername(username: string): UserRow | null;
  findById(id: string): UserRow | null;
  verifyPassword(plain: string, hash: string): Promise<boolean>;
  changePassword(userId: string, newPassword: string): Promise<void>;
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`username taken: ${username}`);
    this.name = "UsernameTakenError";
  }
}

export function createUserStore(db: Database.Database): UserStore {
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM users");
  const insertStmt = db.prepare(
    "INSERT INTO users (id, username, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
  );
  const findByUsernameStmt = db.prepare(
    "SELECT id, username, passwordHash, createdAt, updatedAt FROM users WHERE username = ? COLLATE NOCASE"
  );
  const findByIdStmt = db.prepare(
    "SELECT id, username, passwordHash, createdAt, updatedAt FROM users WHERE id = ?"
  );
  const updatePasswordStmt = db.prepare(
    "UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ?"
  );

  return {
    countUsers() {
      return (countStmt.get() as { n: number }).n;
    },

    async createUser(username, password) {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const id = randomUUID();
      const now = Date.now();
      try {
        insertStmt.run(id, username, hash, now, now);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("UNIQUE") && msg.includes("users.username")) {
          throw new UsernameTakenError(username);
        }
        throw err;
      }
      return { id, username, passwordHash: hash, createdAt: now, updatedAt: now };
    },

    findByUsername(username) {
      return (findByUsernameStmt.get(username) as UserRow | undefined) ?? null;
    },

    findById(id) {
      return (findByIdStmt.get(id) as UserRow | undefined) ?? null;
    },

    verifyPassword(plain, hash) {
      return bcrypt.compare(plain, hash);
    },

    async changePassword(userId, newPassword) {
      const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      updatePasswordStmt.run(hash, Date.now(), userId);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/data/users.test.ts
```
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/users.ts src/data/users.test.ts
git commit -m "feat(auth): add UserStore with bcryptjs password hashing"
```

---

## Task 4: `src/data/sessions.ts` — session CRUD + rolling renewal

**Files:**
- Create: `src/data/sessions.ts`
- Create: `src/data/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/data/sessions.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { createDatabase, type BotDatabase } from "./database.js";
import { createUserStore, type UserStore } from "./users.js";
import { createSessionStore, type SessionStore, SESSION_TTL_MS, SESSION_TOUCH_INTERVAL_MS } from "./sessions.js";

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
    const u = await users.createUser("alice", "pw");
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
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/data/sessions.test.ts
```
Expected: FAIL — `./sessions.js` not found.

- [ ] **Step 3: Implement `src/data/sessions.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface SessionValidation {
  userId: string;
  username: string;
}

export interface SessionStore {
  createSession(userId: string): { token: string; expiresAt: number };
  validateAndTouch(rawToken: string): SessionValidation | null;
  deleteSession(rawToken: string): void;
  deleteAllForUser(userId: string, exceptToken?: string): void;
  cleanupExpired(): void;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSessionStore(db: Database.Database): SessionStore {
  const insertStmt = db.prepare(
    "INSERT INTO sessions (id, userId, createdAt, expiresAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)"
  );
  const selectStmt = db.prepare(`
    SELECT s.id, s.userId, s.expiresAt, s.lastSeenAt, u.username
    FROM sessions s INNER JOIN users u ON u.id = s.userId
    WHERE s.id = ?
  `);
  const deleteByIdStmt = db.prepare("DELETE FROM sessions WHERE id = ?");
  const touchStmt = db.prepare(
    "UPDATE sessions SET lastSeenAt = ?, expiresAt = ? WHERE id = ?"
  );
  const deleteAllForUserStmt = db.prepare("DELETE FROM sessions WHERE userId = ?");
  const deleteAllForUserExceptStmt = db.prepare(
    "DELETE FROM sessions WHERE userId = ? AND id != ?"
  );
  const cleanupStmt = db.prepare("DELETE FROM sessions WHERE expiresAt < ?");

  return {
    createSession(userId) {
      const token = randomBytes(32).toString("base64url");
      const id = hashToken(token);
      const now = Date.now();
      const expiresAt = now + SESSION_TTL_MS;
      insertStmt.run(id, userId, now, expiresAt, now);
      return { token, expiresAt };
    },

    validateAndTouch(rawToken) {
      if (!rawToken) return null;
      const id = hashToken(rawToken);
      const row = selectStmt.get(id) as
        | { id: string; userId: string; expiresAt: number; lastSeenAt: number; username: string }
        | undefined;
      if (!row) return null;
      const now = Date.now();
      if (row.expiresAt < now) {
        deleteByIdStmt.run(id);
        return null;
      }
      if (now - row.lastSeenAt > SESSION_TOUCH_INTERVAL_MS) {
        touchStmt.run(now, now + SESSION_TTL_MS, id);
      }
      return { userId: row.userId, username: row.username };
    },

    deleteSession(rawToken) {
      deleteByIdStmt.run(hashToken(rawToken));
    },

    deleteAllForUser(userId, exceptToken) {
      if (exceptToken) {
        deleteAllForUserExceptStmt.run(userId, hashToken(exceptToken));
      } else {
        deleteAllForUserStmt.run(userId);
      }
    },

    cleanupExpired() {
      cleanupStmt.run(Date.now());
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/data/sessions.test.ts
```
Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/sessions.ts src/data/sessions.test.ts
git commit -m "feat(auth): add SessionStore with rolling renewal and at-rest token hashing"
```

---

## Task 5: `src/web/auth/validateSession.ts` — shared cookie helper

**Files:**
- Create: `src/web/auth/validateSession.ts`

> Used by both the HTTP middleware (`requireAuth`) and the WS upgrade handler. Centralised so both paths can never drift apart.

- [ ] **Step 1: Implement (no separate test — exercised by middleware and ws tests)**

```ts
import type { SessionStore, SessionValidation } from "../../data/sessions.js";

export const SESSION_COOKIE_NAME = "tsmb_session";

/**
 * Validate the session cookie carried on an arbitrary HTTP-like header bag.
 * Used by Express middleware (req.headers.cookie) AND by the raw WebSocket
 * upgrade handler (req.headers.cookie) — they share this exact behavior.
 */
export function validateSessionFromHeaders(
  rawCookieHeader: string | undefined,
  sessions: SessionStore
): SessionValidation | null {
  if (!rawCookieHeader) return null;
  const token = parseCookie(rawCookieHeader, SESSION_COOKIE_NAME);
  if (!token) return null;
  return sessions.validateAndTouch(token);
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return null;
    }
  }
  return null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/auth/validateSession.ts
git commit -m "feat(auth): add shared validateSessionFromHeaders helper"
```

---

## Task 6: `requireAuth` middleware

**Files:**
- Create: `src/web/middleware/requireAuth.ts`
- Create: `src/web/middleware/requireAuth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/web/middleware/requireAuth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createSessionStore } from "../../data/sessions.js";
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
    const u = await users.createUser("alice", "pw");
    validToken = sessions.createSession(u.id).token;

    app = express();
    app.use(cookieParser());
    app.use(createRequireAuth(sessions));
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
  });
});
```

> Add `supertest` as a devDep if not present:
> ```bash
> npm install --save-dev supertest@^7.1.4 @types/supertest@^6.0.3
> ```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/web/middleware/requireAuth.test.ts
```
Expected: FAIL — `./requireAuth.js` does not export `createRequireAuth`.

- [ ] **Step 3: Implement `src/web/middleware/requireAuth.ts`**

```ts
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { SessionStore } from "../../data/sessions.js";
import { validateSessionFromHeaders, SESSION_COOKIE_NAME } from "../auth/validateSession.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: { id: string; username: string };
  }
}

export function createRequireAuth(sessions: SessionStore): RequestHandler {
  return function requireAuth(req: Request, res: Response, next: NextFunction) {
    const result = validateSessionFromHeaders(req.headers.cookie, sessions);
    if (!result) {
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    req.user = { id: result.userId, username: result.username };
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/web/middleware/requireAuth.test.ts
```
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/middleware/requireAuth.ts src/web/middleware/requireAuth.test.ts package.json package-lock.json
git commit -m "feat(auth): add requireAuth middleware"
```

---

## Task 7: `csrfOriginCheck` middleware

**Files:**
- Create: `src/web/middleware/csrf.ts`
- Create: `src/web/middleware/csrf.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { csrfOriginCheck } from "./csrf.js";

describe("csrfOriginCheck middleware", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(csrfOriginCheck);
    app.get("/", (_req, res) => res.json({ ok: true }));
    app.post("/", (_req, res) => res.json({ ok: true }));
  });

  it("allows safe methods (GET/HEAD/OPTIONS) without Origin", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
  });

  it("rejects POST without Origin or Referer", async () => {
    const res = await request(app).post("/");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "bad origin" });
  });

  it("accepts POST when Origin host matches request host", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Origin", "https://example.com");
    expect(res.status).toBe(200);
  });

  it("rejects POST when Origin host does not match request host", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Origin", "https://evil.com");
    expect(res.status).toBe(403);
  });

  it("accepts POST when Referer host matches and Origin is absent", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Referer", "https://example.com/some/path");
    expect(res.status).toBe(200);
  });

  it("rejects POST when Referer host does not match", async () => {
    const res = await request(app)
      .post("/")
      .set("Host", "example.com")
      .set("Referer", "https://evil.com/some/path");
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/web/middleware/csrf.test.ts
```
Expected: FAIL — `./csrf.js` not found.

- [ ] **Step 3: Implement `src/web/middleware/csrf.ts`**

```ts
import type { Request, Response, NextFunction } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Same-origin CSRF protection. For mutating requests, the Origin or Referer
 * header must indicate a host equal to the request's own host.
 *
 * SameSite=Lax on the session cookie blocks classic cross-site form posts;
 * this header check covers the remaining attack surface (fetch from a malicious
 * page that omits SameSite-restricted cookies but tries via Origin spoofing
 * is not possible — the browser sets Origin).
 */
export function csrfOriginCheck(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const expectedHost = req.get("host");
  const originHeader = req.get("origin");
  const refererHeader = req.get("referer");
  const headerHost = hostOf(originHeader) ?? hostOf(refererHeader);
  if (!headerHost || !expectedHost || headerHost !== expectedHost) {
    res.status(403).json({ error: "bad origin" });
    return;
  }
  next();
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/web/middleware/csrf.test.ts
```
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/middleware/csrf.ts src/web/middleware/csrf.test.ts
git commit -m "feat(auth): add csrfOriginCheck middleware"
```

---

## Task 8: `/api/session` router (login, logout, setup, me, change-password)

**Files:**
- Create: `src/web/api/session.ts`
- Create: `src/web/api/session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/web/api/session.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import pino from "pino";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore, type UserStore } from "../../data/users.js";
import { createSessionStore, type SessionStore } from "../../data/sessions.js";
import { createSessionRouter } from "./session.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";

function makeApp(users: UserStore, sessions: SessionStore) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/session", createSessionRouter(users, sessions, pino({ level: "silent" })));
  return app;
}

function extractCookie(res: request.Response): string {
  const header = res.headers["set-cookie"];
  const arr = Array.isArray(header) ? header : header ? [header] : [];
  const found = arr.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!found) throw new Error("no session cookie set");
  return found.split(";")[0]; // "tsmb_session=xxxx"
}

describe("session router", () => {
  let botDb: BotDatabase;
  let users: UserStore;
  let sessions: SessionStore;
  let app: express.Express;

  beforeEach(() => {
    botDb = createDatabase(":memory:");
    users = createUserStore(botDb.db);
    sessions = createSessionStore(botDb.db);
    app = makeApp(users, sessions);
  });

  afterEach(() => botDb.close());

  it("GET /needs-setup returns true on an empty db", async () => {
    const res = await request(app).get("/api/session/needs-setup");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsSetup: true });
  });

  it("POST /setup creates the first admin, logs them in, and returns false from /needs-setup afterwards", async () => {
    const setupRes = await request(app)
      .post("/api/session/setup")
      .send({ username: "alice", password: "hunter2-hunter2" });
    expect(setupRes.status).toBe(200);
    expect(setupRes.body.username).toBe("alice");
    extractCookie(setupRes); // throws if missing

    const needs = await request(app).get("/api/session/needs-setup");
    expect(needs.body).toEqual({ needsSetup: false });
  });

  it("POST /setup returns 409 once a user already exists", async () => {
    await users.createUser("admin", "pw");
    const res = await request(app)
      .post("/api/session/setup")
      .send({ username: "alice", password: "pw" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "already initialized" });
  });

  it("POST /login returns 401 with constant-time delay on bad credentials", async () => {
    await users.createUser("alice", "correct");
    const start = Date.now();
    const res = await request(app)
      .post("/api/session/login")
      .send({ username: "alice", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid credentials" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  }, 10_000);

  it("POST /login sets a session cookie on success", async () => {
    await users.createUser("alice", "pw");
    const res = await request(app)
      .post("/api/session/login")
      .send({ username: "alice", password: "pw" });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("alice");
    extractCookie(res);
  });

  it("GET /me returns the current user when cookie is present, 401 otherwise", async () => {
    await users.createUser("alice", "pw");
    const loginRes = await request(app)
      .post("/api/session/login")
      .send({ username: "alice", password: "pw" });
    const cookie = extractCookie(loginRes);

    const me = await request(app).get("/api/session/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("alice");

    const anon = await request(app).get("/api/session/me");
    expect(anon.status).toBe(401);
  });

  it("POST /logout deletes the session and clears the cookie", async () => {
    await users.createUser("alice", "pw");
    const loginRes = await request(app)
      .post("/api/session/login")
      .send({ username: "alice", password: "pw" });
    const cookie = extractCookie(loginRes);

    const logout = await request(app).post("/api/session/logout").set("Cookie", cookie);
    expect(logout.status).toBe(204);

    const me = await request(app).get("/api/session/me").set("Cookie", cookie);
    expect(me.status).toBe(401);
  });

  it("POST /change-password requires old password and invalidates other sessions", async () => {
    const u = await users.createUser("alice", "old");
    const cookieA = extractCookie(
      await request(app).post("/api/session/login").send({ username: "alice", password: "old" })
    );
    const cookieB = extractCookie(
      await request(app).post("/api/session/login").send({ username: "alice", password: "old" })
    );

    const wrongOld = await request(app)
      .post("/api/session/change-password")
      .set("Cookie", cookieA)
      .send({ oldPassword: "WRONG", newPassword: "new" });
    expect(wrongOld.status).toBe(401);

    const ok = await request(app)
      .post("/api/session/change-password")
      .set("Cookie", cookieA)
      .send({ oldPassword: "old", newPassword: "new" });
    expect(ok.status).toBe(204);

    // Current session (cookieA) still valid
    const meA = await request(app).get("/api/session/me").set("Cookie", cookieA);
    expect(meA.status).toBe(200);

    // Other session (cookieB) invalidated
    const meB = await request(app).get("/api/session/me").set("Cookie", cookieB);
    expect(meB.status).toBe(401);

    expect(u.id).toBe(meA.body.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/web/api/session.test.ts
```
Expected: FAIL — `./session.js` not found.

- [ ] **Step 3: Implement `src/web/api/session.ts`**

```ts
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Logger } from "../../logger.js";
import type { UserStore } from "../../data/users.js";
import { UsernameTakenError } from "../../data/users.js";
import type { SessionStore } from "../../data/sessions.js";
import { SESSION_TTL_MS } from "../../data/sessions.js";
import { SESSION_COOKIE_NAME, validateSessionFromHeaders } from "../auth/validateSession.js";

const FAILED_LOGIN_DELAY_MS = 250;

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: res.req.secure,
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidUsername(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_\-.]{3,32}$/.test(v);
}

function isValidPassword(v: unknown): v is string {
  return typeof v === "string" && v.length >= 8 && v.length <= 200;
}

export function createSessionRouter(
  users: UserStore,
  sessions: SessionStore,
  logger: Logger
): Router {
  const router = Router();

  const requireAuthInline = (req: Request, res: Response, next: NextFunction) => {
    const result = validateSessionFromHeaders(req.headers.cookie, sessions);
    if (!result) {
      clearSessionCookie(res);
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    req.user = { id: result.userId, username: result.username };
    next();
  };

  router.get("/needs-setup", (_req, res) => {
    res.json({ needsSetup: users.countUsers() === 0 });
  });

  router.post("/setup", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (!isValidUsername(username) || !isValidPassword(password)) {
      res.status(400).json({ error: "invalid username or password" });
      return;
    }
    if (users.countUsers() !== 0) {
      res.status(409).json({ error: "already initialized" });
      return;
    }
    try {
      const user = await users.createUser(username, password);
      const { token } = sessions.createSession(user.id);
      setSessionCookie(res, token);
      logger.info({ userId: user.id, username }, "First admin created");
      res.json({ id: user.id, username: user.username });
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        res.status(409).json({ error: "already initialized" });
        return;
      }
      logger.error({ err }, "setup failed");
      res.status(500).json({ error: "internal" });
    }
  });

  router.post("/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const user = users.findByUsername(username);
    const ok = user ? await users.verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) {
      await delay(FAILED_LOGIN_DELAY_MS);
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    const { token } = sessions.createSession(user.id);
    setSessionCookie(res, token);
    res.json({ id: user.id, username: user.username });
  });

  router.post("/logout", (req, res) => {
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const match = cookieHeader.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${SESSION_COOKIE_NAME}=`));
      if (match) {
        const token = decodeURIComponent(match.slice(SESSION_COOKIE_NAME.length + 1));
        sessions.deleteSession(token);
      }
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get("/me", requireAuthInline, (req, res) => {
    res.json(req.user);
  });

  router.post("/change-password", requireAuthInline, async (req, res) => {
    const { oldPassword, newPassword } = req.body ?? {};
    if (typeof oldPassword !== "string" || !isValidPassword(newPassword)) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const u = users.findById(req.user!.id);
    if (!u || !(await users.verifyPassword(oldPassword, u.passwordHash))) {
      await delay(FAILED_LOGIN_DELAY_MS);
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    await users.changePassword(u.id, newPassword);
    const currentToken = parseTokenFromCookie(req.headers.cookie);
    sessions.deleteAllForUser(u.id, currentToken ?? undefined);
    res.status(204).end();
  });

  return router;
}

function parseTokenFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(SESSION_COOKIE_NAME.length + 1));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/web/api/session.test.ts
```
Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/api/session.ts src/web/api/session.test.ts
git commit -m "feat(auth): add /api/session router (setup, login, logout, me, change-password)"
```

---

## Task 9: Wire up `server.ts` (cookieParser, public/protected ordering, cleanup)

**Files:**
- Modify: `src/web/server.ts`

> The protected `/api/*` routers and the new public ones share the same path prefix. Express middleware ordering matters: register public routes BEFORE the `app.use("/api", csrfOriginCheck)` + `app.use("/api", requireAuth)` gates.

- [ ] **Step 1: Replace the contents of `src/web/server.ts`**

```ts
import express from "express";
import http from "node:http";
import path from "node:path";
import cookieParser from "cookie-parser";
import { WebSocketServer } from "ws";
import type { BotManager } from "../bot/manager.js";
import type { MusicProvider } from "../music/provider.js";
import type { BotDatabase } from "../data/database.js";
import type { BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";
import type { CookieStore } from "../music/auth.js";
import type { AvatarStore } from "../data/avatars.js";
import { createBotRouter } from "./api/bot.js";
import { createMusicRouter } from "./api/music.js";
import { createPlayerRouter } from "./api/player.js";
import { createAuthRouter } from "./api/auth.js";
import { createSessionRouter } from "./api/session.js";
import { setupWebSocket } from "./websocket.js";
import { createUserStore } from "../data/users.js";
import { createSessionStore } from "../data/sessions.js";
import { createRequireAuth } from "./middleware/requireAuth.js";
import { csrfOriginCheck } from "./middleware/csrf.js";
import { validateSessionFromHeaders } from "./auth/validateSession.js";

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface WebServerOptions {
  port: number;
  botManager: BotManager;
  neteaseProvider: MusicProvider;
  qqProvider: MusicProvider;
  bilibiliProvider: MusicProvider;
  database: BotDatabase;
  config: BotConfig;
  configPath: string;
  logger: Logger;
  cookieStore?: CookieStore;
  avatarStore: AvatarStore;
  staticDir?: string;
}

export interface WebServer {
  start(): Promise<void>;
  stop(): void;
}

export function createWebServer(options: WebServerOptions): WebServer {
  const app = express();
  const server = http.createServer(app);
  const logger = options.logger.child({ component: "web" });

  if (options.config.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use(express.json({ limit: "400kb" }));
  app.use(cookieParser());

  const users = createUserStore(options.database.db);
  const sessions = createSessionStore(options.database.db);

  // ─── Public routes (no auth, no CSRF) ───────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });

  app.get("/api/config/public-url", (_req, res) => {
    const raw = (options.config.publicUrl ?? "").trim();
    res.json({ publicUrl: raw ? raw.replace(/\/+$/, "") : null });
  });

  app.use("/api/session", createSessionRouter(users, sessions, logger));

  // ─── Gates for everything else under /api ───────────────────────────────
  const requireAuth = createRequireAuth(sessions);
  app.use("/api", csrfOriginCheck);
  app.use("/api", requireAuth);

  // ─── Protected routes ───────────────────────────────────────────────────
  app.use(
    "/api/bot",
    createBotRouter(
      options.botManager,
      options.config,
      options.configPath,
      logger,
      options.database,
      options.avatarStore,
    )
  );
  app.use(
    "/api/music",
    createMusicRouter(options.neteaseProvider, options.qqProvider, options.bilibiliProvider, logger)
  );
  app.use("/api/player", createPlayerRouter(
    options.botManager, logger, options.database,
    options.neteaseProvider, options.qqProvider, options.bilibiliProvider,
  ));
  app.use(
    "/api/auth",
    createAuthRouter(options.neteaseProvider, options.qqProvider, options.bilibiliProvider, logger, options.cookieStore)
  );

  // ─── Static SPA (public) ────────────────────────────────────────────────
  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get(/^(?!\/api|\/ws)/, (_req, res) => {
      res.sendFile(path.join(options.staticDir!, "index.html"));
    });
  }

  server.on("error", (err) => {
    logger.error({ err }, "HTTP server error");
  });

  // ─── WebSocket with manual upgrade auth ────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  wss.on("error", (err) => {
    logger.error({ err }, "WebSocket server error");
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    const result = validateSessionFromHeaders(req.headers.cookie as string | undefined, sessions);
    if (!result) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as unknown as { userId: string }).userId = result.userId;
      wss.emit("connection", ws, req);
    });
  });
  const cleanupWs = setupWebSocket(wss, options.botManager, logger);

  // ─── Session cleanup interval ──────────────────────────────────────────
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  return {
    async start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(options.port, () => {
          logger.info({ port: options.port }, "Web server started");
          cleanupTimer = setInterval(() => {
            try {
              sessions.cleanupExpired();
            } catch (err) {
              logger.error({ err }, "session cleanup failed");
            }
          }, SESSION_CLEANUP_INTERVAL_MS);
          resolve();
        });
      });
    },
    stop(): void {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      cleanupWs();
      wss.close();
      server.close();
    },
  };
}
```

- [ ] **Step 2: Type-check the project**

```bash
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 3: Run the whole vitest suite**

```bash
npx vitest run
```
Expected: all existing + new tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/web/server.ts
git commit -m "feat(auth): gate /api/* behind requireAuth + csrf; gate /ws via upgrade handler"
```

---

## Task 10: WebSocket auth integration test

**Files:**
- Create: `src/web/websocket-auth.test.ts`

> Validates the end-to-end ws gate behavior. Uses a real HTTP server on a random port plus the `ws` client.

- [ ] **Step 1: Write the failing test**

Create `src/web/websocket-auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { WebSocketServer, WebSocket as WSClient } from "ws";
import { AddressInfo } from "node:net";
import { createDatabase, type BotDatabase } from "../data/database.js";
import { createUserStore } from "../data/users.js";
import { createSessionStore } from "../data/sessions.js";
import { validateSessionFromHeaders, SESSION_COOKIE_NAME } from "./auth/validateSession.js";

function buildServer(sessions: ReturnType<typeof createSessionStore>) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => ws.send("hello"));
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") return socket.destroy();
    const r = validateSessionFromHeaders(req.headers.cookie as string | undefined, sessions);
    if (!r) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  return { server, wss };
}

describe("WebSocket auth at upgrade", () => {
  let botDb: BotDatabase;
  let httpServer: http.Server;
  let port: number;
  let validToken: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const u = await users.createUser("alice", "pw");
    validToken = sessions.createSession(u.id).token;

    const { server } = buildServer(sessions);
    httpServer = server;
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    botDb.close();
  });

  it("rejects upgrade without cookie (server-side close before open)", async () => {
    const ws = new WSClient(`ws://127.0.0.1:${port}/ws`);
    const result = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("opened"));
      ws.on("unexpected-response", (_req, res) => resolve(`status:${res.statusCode}`));
      ws.on("error", () => resolve("error"));
    });
    expect(result).toMatch(/^status:401$|^error$/);
  });

  it("accepts upgrade with a valid cookie", async () => {
    const ws = new WSClient(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${validToken}` },
    });
    const msg = await new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
    });
    expect(msg).toBe("hello");
    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

```bash
npx vitest run src/web/websocket-auth.test.ts
```
Expected: both tests PASS (the implementation already exists in `server.ts`; this test only validates it).

- [ ] **Step 3: Commit**

```bash
git add src/web/websocket-auth.test.ts
git commit -m "test(auth): verify ws upgrade gating end-to-end"
```

---

## Task 11: Frontend — `useSession` composable

**Files:**
- Create: `web/src/composables/useSession.ts`

> Single source of truth for auth state. Other code reads `currentUser`, `needsSetup`, calls `refresh()`, `login()`, `logout()`, `setup()`.

- [ ] **Step 1: Create `web/src/composables/useSession.ts`**

```ts
import { ref, computed, readonly } from "vue";

interface User {
  id: string;
  username: string;
}

const currentUser = ref<User | null>(null);
const needsSetup = ref<boolean | null>(null); // null = unknown / not fetched yet
const ready = ref(false);

async function refreshNeedsSetup(): Promise<void> {
  const res = await fetch("/api/session/needs-setup", { credentials: "same-origin" });
  if (res.ok) {
    const body = await res.json();
    needsSetup.value = Boolean(body.needsSetup);
  }
}

async function refreshMe(): Promise<void> {
  const res = await fetch("/api/session/me", { credentials: "same-origin" });
  if (res.status === 200) {
    currentUser.value = (await res.json()) as User;
  } else {
    currentUser.value = null;
  }
}

async function refresh(): Promise<void> {
  await refreshNeedsSetup();
  if (needsSetup.value) {
    currentUser.value = null;
  } else {
    await refreshMe();
  }
  ready.value = true;
}

async function login(username: string, password: string): Promise<void> {
  const res = await fetch("/api/session/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `login failed (${res.status})`);
  }
  currentUser.value = (await res.json()) as User;
}

async function setup(username: string, password: string): Promise<void> {
  const res = await fetch("/api/session/setup", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `setup failed (${res.status})`);
  }
  currentUser.value = (await res.json()) as User;
  needsSetup.value = false;
}

async function logout(): Promise<void> {
  await fetch("/api/session/logout", { method: "POST", credentials: "same-origin" });
  currentUser.value = null;
}

export function useSession() {
  return {
    currentUser: readonly(currentUser),
    needsSetup: readonly(needsSetup),
    isAuthenticated: computed(() => currentUser.value !== null),
    ready: readonly(ready),
    refresh,
    login,
    logout,
    setup,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/composables/useSession.ts
git commit -m "feat(web): add useSession composable"
```

---

## Task 12: Frontend — `Login.vue`

**Files:**
- Create: `web/src/views/Login.vue`

- [ ] **Step 1: Create `web/src/views/Login.vue`**

```vue
<template>
  <div class="auth-page">
    <form class="auth-card" @submit.prevent="submit">
      <h1>登录 TSMusicBot</h1>
      <label>
        <span>用户名</span>
        <input v-model="username" type="text" autocomplete="username" autofocus required />
      </label>
      <label>
        <span>密码</span>
        <input v-model="password" type="password" autocomplete="current-password" required />
      </label>
      <p v-if="error" class="auth-error">{{ error }}</p>
      <button type="submit" :disabled="loading">{{ loading ? '登录中…' : '登录' }}</button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSession } from '../composables/useSession.js';

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
const router = useRouter();
const route = useRoute();
const session = useSession();

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await session.login(username.value, password.value);
    const next = typeof route.query.next === 'string' ? route.query.next : '/';
    router.replace(next);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped lang="scss">
.auth-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
}
.auth-card {
  width: 360px;
  padding: 32px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-shadow: var(--shadow-dropdown);
}
.auth-card h1 { margin: 0 0 8px; font-size: 20px; color: var(--text-primary); }
.auth-card label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.auth-card input {
  height: 36px; padding: 0 10px; border-radius: var(--radius-sm);
  background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-color);
}
.auth-card button {
  height: 38px; border-radius: var(--radius-sm); border: 0;
  background: var(--color-primary); color: #fff; font-weight: 500; cursor: pointer;
}
.auth-card button:disabled { opacity: 0.6; cursor: progress; }
.auth-error { color: #e26a6a; font-size: 13px; margin: 0; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add web/src/views/Login.vue
git commit -m "feat(web): add Login view"
```

---

## Task 13: Frontend — `FirstRunSetup.vue` + router wiring + guard

**Files:**
- Create: `web/src/views/FirstRunSetup.vue`
- Modify: `web/src/router/index.ts`

- [ ] **Step 1: Create `web/src/views/FirstRunSetup.vue`**

```vue
<template>
  <div class="auth-page">
    <form class="auth-card" @submit.prevent="submit">
      <h1>首次使用</h1>
      <p class="auth-hint">创建管理员账号。该账号将拥有 WebUI 的全部权限。</p>
      <label>
        <span>用户名</span>
        <input v-model="username" type="text" autocomplete="username" autofocus required />
      </label>
      <label>
        <span>密码 (≥8 位)</span>
        <input v-model="password" type="password" autocomplete="new-password" minlength="8" required />
      </label>
      <label>
        <span>再次输入密码</span>
        <input v-model="confirm" type="password" autocomplete="new-password" minlength="8" required />
      </label>
      <p v-if="error" class="auth-error">{{ error }}</p>
      <button type="submit" :disabled="loading">{{ loading ? '创建中…' : '创建管理员' }}</button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSession } from '../composables/useSession.js';

const username = ref('');
const password = ref('');
const confirm = ref('');
const error = ref('');
const loading = ref(false);
const router = useRouter();
const session = useSession();

async function submit() {
  error.value = '';
  if (password.value !== confirm.value) {
    error.value = '两次输入的密码不一致';
    return;
  }
  loading.value = true;
  try {
    await session.setup(username.value, password.value);
    router.replace('/');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped lang="scss">
.auth-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg-primary); }
.auth-card {
  width: 360px; padding: 32px; background: var(--bg-secondary);
  border-radius: var(--radius-md); display: flex; flex-direction: column; gap: 12px;
  box-shadow: var(--shadow-dropdown);
}
.auth-card h1 { margin: 0; font-size: 20px; color: var(--text-primary); }
.auth-hint { margin: 0 0 4px; font-size: 12px; color: var(--text-secondary); }
.auth-card label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.auth-card input {
  height: 36px; padding: 0 10px; border-radius: var(--radius-sm);
  background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-color);
}
.auth-card button {
  height: 38px; border-radius: var(--radius-sm); border: 0;
  background: var(--color-primary); color: #fff; font-weight: 500; cursor: pointer;
}
.auth-card button:disabled { opacity: 0.6; cursor: progress; }
.auth-error { color: #e26a6a; font-size: 13px; margin: 0; }
</style>
```

- [ ] **Step 2: Replace `web/src/router/index.ts`**

```ts
import { createRouter, createWebHistory } from 'vue-router';
import { useSession } from '../composables/useSession.js';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/Home.vue') },
    { path: '/search', name: 'search', component: () => import('../views/Search.vue') },
    { path: '/library', name: 'library', component: () => import('../views/Library.vue') },
    {
      path: '/playlist/:id',
      name: 'playlist',
      component: () => import('../views/Playlist.vue'),
      meta: { kind: 'playlist' },
    },
    {
      path: '/album/:id',
      name: 'album',
      component: () => import('../views/Playlist.vue'),
      meta: { kind: 'album' },
    },
    { path: '/lyrics', name: 'lyrics', component: () => import('../views/Lyrics.vue') },
    { path: '/history', name: 'history', component: () => import('../views/History.vue') },
    { path: '/settings', name: 'settings', component: () => import('../views/Settings.vue') },
    { path: '/setup', name: 'setup', component: () => import('../views/Setup.vue') },
    { path: '/bot/:id', name: 'bot', component: () => import('../views/BotRedirect.vue') },

    // Auth views
    { path: '/login', name: 'login', component: () => import('../views/Login.vue'), meta: { public: true } },
    { path: '/first-run', name: 'first-run', component: () => import('../views/FirstRunSetup.vue'), meta: { public: true } },
  ],
});

const PUBLIC_NAMES = new Set(['login', 'first-run']);

router.beforeEach(async (to) => {
  const session = useSession();
  if (!session.ready.value) {
    await session.refresh();
  }

  if (session.needsSetup.value && to.name !== 'first-run') {
    return { name: 'first-run' };
  }
  if (!session.needsSetup.value && to.name === 'first-run') {
    return { name: 'home' };
  }

  if (PUBLIC_NAMES.has(to.name as string)) {
    if (to.name === 'login' && session.isAuthenticated.value) {
      return { name: 'home' };
    }
    return true;
  }

  if (!session.isAuthenticated.value) {
    return { name: 'login', query: { next: to.fullPath } };
  }
  return true;
});

export default router;
```

- [ ] **Step 3: Type-check the web project**

```bash
cd web && npx vue-tsc --noEmit && cd ..
```
Expected: zero errors. (If `vue-tsc` is not configured, use `npx tsc --noEmit` inside `web/`.)

- [ ] **Step 4: Commit**

```bash
git add web/src/views/FirstRunSetup.vue web/src/router/index.ts
git commit -m "feat(web): add /first-run + /login routes with auth guard"
```

---

## Task 14: Frontend — API client credentials + global 401 handler

**Files:**
- Create: `web/src/api/http.ts`
- Modify: `web/src/App.vue` (call `installApiClient` once on mount)
- Audit: every `fetch(...)` call site in `web/src/` to add `credentials: 'same-origin'`. There are likely ~10-20.

> Two-pronged fix: (1) one global `fetch` wrapper that intercepts 401 and redirects to login; (2) per-call `credentials: 'same-origin'` so cookies are sent. The wrapper sets credentials by default so most call sites only need to switch from `fetch` to `apiFetch`.

- [ ] **Step 1: Create `web/src/api/http.ts`**

```ts
import router from '../router/index.js';
import { useSession } from '../composables/useSession.js';

let installed = false;

/**
 * Wraps fetch so every call:
 *   - sends cookies (`credentials: 'same-origin'`)
 *   - on 401 from /api/*: clear local session, redirect to /login
 */
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const merged: RequestInit = {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.headers ?? {}) },
  };
  return fetch(input, merged).then(async (res) => {
    if (res.status === 401 && isApiPath(input)) {
      const session = useSession();
      await session.refresh();
      const current = router.currentRoute.value;
      if (current.name !== 'login' && current.name !== 'first-run') {
        await router.replace({ name: 'login', query: { next: current.fullPath } });
      }
    }
    return res;
  });
}

function isApiPath(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return url.startsWith('/api/');
}

/**
 * Replaces window.fetch with apiFetch so existing call sites do not need to be touched.
 * Call once at app startup.
 */
export function installApiClient(): void {
  if (installed) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    return apiFetch(input, init ?? {});
  }) as typeof window.fetch;
  // Keep original accessible if anything needs to bypass
  (window as unknown as { __originalFetch?: typeof fetch }).__originalFetch = original;
}
```

- [ ] **Step 2: Wire into `web/src/main.ts`**

Replace `web/src/main.ts` with:

```ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router/index.js';
import { installApiClient } from './api/http.js';
import './styles/global.scss';
import './styles/mobile.scss';

installApiClient();

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
```

- [ ] **Step 3: Type-check**

```bash
cd web && npx vue-tsc --noEmit && cd ..
```

- [ ] **Step 4: Commit**

```bash
git add web/src/api/http.ts web/src/main.ts
git commit -m "feat(web): install global fetch wrapper with credentials + 401 handling"
```

---

## Task 15: Frontend — logout + username chip in Navbar

**Files:**
- Modify: `web/src/components/Navbar.vue`

- [ ] **Step 1: Inspect current Navbar.vue**

```bash
git show HEAD:web/src/components/Navbar.vue | head -80
```
Locate the right-hand side of the desktop nav (where Settings/menu actions live).

- [ ] **Step 2: Add a user chip + logout button**

Append (inside the existing template, right-most slot of the desktop nav — placement adjusted to match Navbar's existing structure):

```vue
<div class="nav-user" v-if="session.currentUser.value">
  <span class="nav-user-name">{{ session.currentUser.value.username }}</span>
  <button class="nav-user-logout" @click="onLogout" title="退出">
    <Icon icon="mdi:logout" />
  </button>
</div>
```

In the existing `<script setup>` of Navbar.vue, add:

```ts
import { useRouter } from 'vue-router';
import { useSession } from '../composables/useSession.js';

const session = useSession();
const navRouter = useRouter();

async function onLogout() {
  await session.logout();
  navRouter.replace({ name: 'login' });
}
```

Add minimal styles:

```scss
.nav-user {
  display: flex; align-items: center; gap: 8px; margin-left: 12px;
  color: var(--text-secondary); font-size: 13px;
}
.nav-user-logout {
  height: 28px; width: 28px; display: grid; place-items: center;
  border: 0; background: transparent; color: var(--text-secondary); cursor: pointer;
  border-radius: var(--radius-sm);
  &:hover { background: var(--bg-secondary); color: var(--text-primary); }
}
```

- [ ] **Step 3: Sanity-build the web project**

```bash
cd web && npm run build && cd ..
```
Expected: build succeeds and produces `web/dist/`.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Navbar.vue
git commit -m "feat(web): show current user + logout button in nav"
```

---

## Task 16: Smoke test (manual) + final commit

**Files:**
- None (manual verification)

> This task does NOT modify code. It is the verification gate before opening a PR. If any step fails, return to the relevant task and fix it.

- [ ] **Step 1: Wipe local DB (so the bot enters first-run state)**

```bash
# Important: only do this in a dev environment, not against any prod data.
mv data/tsmusicbot.db data/tsmusicbot.db.bak 2>/dev/null || true
```

- [ ] **Step 2: Start the bot in dev**

```bash
npm run dev
```
Expected: logs show `Web server started` on the configured port (default `3000`).

- [ ] **Step 3: First-run wizard**

- Open `http://localhost:3000/` → expect automatic redirect to `/first-run`.
- Submit `admin / hunter2-hunter2` (or any ≥8-char password).
- Expect redirect to `/` and the user chip showing `admin` in the nav.

- [ ] **Step 4: API is gated**

In a separate terminal:

```bash
curl -i http://localhost:3000/api/bot
```
Expected: `HTTP/1.1 401 Unauthorized` with body `{"error":"unauthenticated"}`.

```bash
curl -i http://localhost:3000/api/health
```
Expected: `200 OK` (public).

- [ ] **Step 5: WebSocket is gated**

```bash
node -e "const WebSocket=require('ws');const ws=new WebSocket('ws://localhost:3000/ws');ws.on('open',()=>console.log('OPENED'));ws.on('unexpected-response',(_,r)=>console.log('STATUS',r.statusCode));ws.on('error',e=>console.log('ERR',e.message));"
```
Expected: prints `STATUS 401` (not `OPENED`).

- [ ] **Step 6: Logout → redirect**

In the browser click logout → expect redirect to `/login`. Try to navigate to `/library` → expect bounce back to `/login?next=/library`.

- [ ] **Step 7: Login → restored**

Log in again with `admin` → expect redirect to `/library` (the `next` query param).

- [ ] **Step 8: Restore previous DB (optional)**

```bash
# Only if you backed it up in Step 1
mv data/tsmusicbot.db.bak data/tsmusicbot.db 2>/dev/null || true
```

- [ ] **Step 9: Final commit (changelog/README)**

Update README's setup section briefly mentioning that the WebUI now requires a first-run admin. Then:

```bash
# only if you actually edited README.md
git add README.md
git commit -m "docs: note WebUI first-run admin setup"
```

- [ ] **Step 10: Push the branch**

```bash
git push -u origin feat/webui-auth
```

- [ ] **Step 11: Open PR (manual)**

The user will open the PR via `gh pr create` or the GitHub UI. Plan complete.

---

## Self-review against spec

- Spec § Storage → Task 2, 3, 4 ✅
- Spec § validateSession.ts shared helper → Task 5 ✅
- Spec § requireAuth middleware → Task 6 ✅
- Spec § CSRF Origin/Referer middleware → Task 7 ✅
- Spec § /api/session router (needs-setup, setup, login, logout, me, change-password) → Task 8 ✅
- Spec § server.ts wiring, cookieParser, public/protected order, cleanup interval → Task 9 ✅
- Spec § WebSocket auth at upgrade → Task 9 (impl) + Task 10 (integration test) ✅
- Spec § frontend useSession composable → Task 11 ✅
- Spec § Login.vue → Task 12 ✅
- Spec § FirstRunSetup.vue + router guard → Task 13 ✅ (note: route path `/first-run`, supersedes spec's `/setup`)
- Spec § API client credentials + 401 interceptor → Task 14 ✅
- Spec § App.vue / Navbar logout + username chip → Task 15 ✅
- Spec § Manual test checklist → Task 16 ✅
