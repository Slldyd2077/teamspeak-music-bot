# Account Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin grant each member account a set of capabilities and a list of bots they may control, enforced on the backend.

**Architecture:** Capability tokens + per-member bot allow-list stored in two new SQLite tables, loaded onto `req.user` per request (live, no re-login), enforced by `requirePermission` / `requireBotAccess` middleware mirroring the existing `requireAdmin`. Admin stays a super-user. Existing members are backfilled to full access on upgrade; new members get a basic tier. The Vue UI hides what a member can't do and gives admins a permission editor.

**Tech Stack:** Node ESM + TypeScript, Express, better-sqlite3, Vitest + supertest, Vue 3 + Pinia.

**Spec:** `docs/superpowers/specs/2026-05-30-account-permissions-design.md`

**Conventions:** All file paths are repo-relative. Tests run with `npx vitest run <path>`. Backend is TDD (test first, watch fail, implement, watch pass, commit). Commit after each task.

---

## File Structure

**Create:**
- `src/data/permissions.ts` — capability constants + `PermissionStore` (tables accessed here)
- `src/data/permissions.test.ts` — store + constants tests
- `src/web/middleware/requirePermission.ts` — `requirePermission(cap)` + `requireBotAccess(param)`
- `src/web/middleware/requirePermission.test.ts` — middleware tests

**Modify:**
- `src/data/database.ts` — `initTables`: add the two tables + index; migration backfill of existing members
- `src/data/audit.ts` — add `"user.permissions_changed"` to `AuditAction`
- `src/web/middleware/requireAuth.ts` — widen `req.user`; load capabilities + bot access
- `src/web/auth/validateSession.ts` — (no change; just confirm) — actually unchanged
- `src/web/api/session.ts` — `/me` returns capabilities + bots; inline auth attaches them
- `src/web/server.ts` — construct `PermissionStore`, pass into routers/middleware
- `src/web/api/player.ts` — `requireBotAccess` on `/:botId`; per-route `requirePermission`
- `src/web/api/bot.ts` — `requirePermission("bot.manage")` + `requireBotAccess("id")`
- `src/web/api/auth.ts` — `requirePermission("platform.auth")`
- `src/web/api/music.ts` — `requirePermission("quality")` on the quality POST; filter `GET /api/bot`? no — bot list is in bot.ts
- `src/web/api/bot.ts` — filter `GET /` to allowed bots for members
- `src/web/api/users.ts` — `GET/PUT /api/users/:id/permissions`
- `src/bot/manager.ts` — `removeBot` calls `permissions.pruneBot(botId)`
- Frontend: `web/src/composables/useSession.ts`, `web/src/components/Navbar.vue`, `web/src/components/Player.vue`, `web/src/views/Settings.vue`, `web/src/stores/player.ts`

---

## Task 1: Capability constants + PermissionStore + tables

**Files:**
- Create: `src/data/permissions.ts`
- Create: `src/data/permissions.test.ts`
- Modify: `src/data/database.ts` (initTables)

- [ ] **Step 1: Write the failing test**

`src/data/permissions.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase, type BotDatabase } from "./database.js";
import { createPermissionStore } from "./permissions.js";
import { CAPABILITIES, BASIC_TIER_CAPABILITIES } from "./permissions.js";

describe("PermissionStore", () => {
  let dbFile: string;
  let db: BotDatabase;

  beforeEach(() => {
    dbFile = path.join(os.tmpdir(), `perm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = createDatabase(dbFile);
    // a user row is required for FK; insert directly
    db.db.prepare(
      "INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES (?,?,?,?,?,?)"
    ).run("u1", "alice", "x", Date.now(), Date.now(), "member");
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(dbFile, { force: true }); } catch {}
    try { fs.rmSync(dbFile + "-wal", { force: true }); } catch {}
    try { fs.rmSync(dbFile + "-shm", { force: true }); } catch {}
  });

  it("exposes the five capability tokens and a basic tier", () => {
    expect(CAPABILITIES).toEqual([
      "player.control", "player.queue", "bot.manage", "platform.auth", "quality",
    ]);
    expect(BASIC_TIER_CAPABILITIES).toEqual(["player.control", "player.queue"]);
  });

  it("defaults to no capabilities and no bots", () => {
    const store = createPermissionStore(db.db);
    expect(store.getCapabilities("u1")).toEqual([]);
    expect(store.getBotAccess("u1")).toEqual([]);
  });

  it("round-trips capabilities and a specific bot list", () => {
    const store = createPermissionStore(db.db);
    store.setPermissions("u1", { capabilities: ["player.control", "quality"], bots: ["botA", "botB"] });
    expect(store.getCapabilities("u1").sort()).toEqual(["player.control", "quality"]);
    expect(store.getBotAccess("u1")).toEqual(["botA", "botB"]);
  });

  it("stores the all-bots flag as 'all'", () => {
    const store = createPermissionStore(db.db);
    store.setPermissions("u1", { capabilities: ["player.control"], bots: "all" });
    expect(store.getBotAccess("u1")).toBe("all");
  });

  it("setPermissions replaces prior capabilities and bots", () => {
    const store = createPermissionStore(db.db);
    store.setPermissions("u1", { capabilities: ["player.control"], bots: ["botA"] });
    store.setPermissions("u1", { capabilities: ["quality"], bots: "all" });
    expect(store.getCapabilities("u1")).toEqual(["quality"]);
    expect(store.getBotAccess("u1")).toBe("all");
  });

  it("ignores unknown capability tokens", () => {
    const store = createPermissionStore(db.db);
    store.setPermissions("u1", { capabilities: ["player.control", "bogus" as any], bots: [] });
    expect(store.getCapabilities("u1")).toEqual(["player.control"]);
  });

  it("pruneBot removes a bot from every user's allow-list", () => {
    const store = createPermissionStore(db.db);
    store.setPermissions("u1", { capabilities: [], bots: ["botA", "botB"] });
    store.pruneBot("botA");
    expect(store.getBotAccess("u1")).toEqual(["botB"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/permissions.test.ts`
Expected: FAIL — `createPermissionStore` / `CAPABILITIES` not found (module missing).

- [ ] **Step 3: Create `src/data/permissions.ts`**

```typescript
import type Database from "better-sqlite3";

export const CAPABILITIES = [
  "player.control",
  "player.queue",
  "bot.manage",
  "platform.auth",
  "quality",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Marker token stored in user_permissions meaning "all bots, incl. future". */
export const BOTS_ALL = "bots.all";

/** Capabilities granted to a newly-created member by default. */
export const BASIC_TIER_CAPABILITIES: Capability[] = ["player.control", "player.queue"];

export function isCapability(x: string): x is Capability {
  return (CAPABILITIES as readonly string[]).includes(x);
}

export type BotAccess = "all" | string[];

export interface PermissionStore {
  getCapabilities(userId: string): Capability[];
  getBotAccess(userId: string): BotAccess;
  setPermissions(userId: string, input: { capabilities: string[]; bots: BotAccess }): void;
  pruneBot(botId: string): void;
}

export function createPermissionStore(db: Database.Database): PermissionStore {
  const selCaps = db.prepare("SELECT permission FROM user_permissions WHERE userId = ?");
  const delCaps = db.prepare("DELETE FROM user_permissions WHERE userId = ?");
  const insCap = db.prepare("INSERT OR IGNORE INTO user_permissions (userId, permission) VALUES (?, ?)");
  const selBots = db.prepare("SELECT botId FROM user_bot_access WHERE userId = ?");
  const delBots = db.prepare("DELETE FROM user_bot_access WHERE userId = ?");
  const insBot = db.prepare("INSERT OR IGNORE INTO user_bot_access (userId, botId) VALUES (?, ?)");
  const pruneBotStmt = db.prepare("DELETE FROM user_bot_access WHERE botId = ?");

  return {
    getCapabilities(userId) {
      return (selCaps.all(userId) as { permission: string }[])
        .map((r) => r.permission)
        .filter((p): p is Capability => isCapability(p));
    },
    getBotAccess(userId) {
      const all = (selCaps.all(userId) as { permission: string }[]).some((r) => r.permission === BOTS_ALL);
      if (all) return "all";
      return (selBots.all(userId) as { botId: string }[]).map((r) => r.botId);
    },
    setPermissions(userId, input) {
      const caps = input.capabilities.filter(isCapability);
      const tx = db.transaction(() => {
        delCaps.run(userId);
        delBots.run(userId);
        for (const c of caps) insCap.run(userId, c);
        if (input.bots === "all") {
          insCap.run(userId, BOTS_ALL);
        } else {
          for (const b of input.bots) insBot.run(userId, b);
        }
      });
      tx();
    },
    pruneBot(botId) {
      pruneBotStmt.run(botId);
    },
  };
}
```

- [ ] **Step 4: Add tables in `src/data/database.ts` initTables**

Find `initTables` (creates users/sessions/user_audit). Add, after the `user_audit` CREATE:

```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_permissions (
      userId     TEXT NOT NULL,
      permission TEXT NOT NULL,
      PRIMARY KEY (userId, permission),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS user_bot_access (
      userId TEXT NOT NULL,
      botId  TEXT NOT NULL,
      PRIMARY KEY (userId, botId),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_bot_access_userId ON user_bot_access(userId);
  `);
```

(If `initTables` uses individual `db.exec` calls, match that style. The `BotDatabase` type already exposes `.db` and `.close()` — confirm by reading the file; the test uses `db.db` and `db.close()`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/data/permissions.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/data/permissions.ts src/data/permissions.test.ts src/data/database.ts
git commit -m "feat(perm): permission store + capability tokens + tables"
```

---

## Task 2: requirePermission + requireBotAccess middleware

**Files:**
- Create: `src/web/middleware/requirePermission.ts`
- Create: `src/web/middleware/requirePermission.test.ts`
- Modify: `src/web/middleware/requireAuth.ts` (widen `req.user`)

- [ ] **Step 1: Widen the `req.user` augmentation in `src/web/middleware/requireAuth.ts`**

Change the `declare module` block so `req.user` carries capabilities + bot access:

```typescript
declare module "express-serve-static-core" {
  interface Request {
    user?: {
      id: string;
      username: string;
      role: "admin" | "member";
      capabilities: Set<string>;
      bots: "all" | Set<string>;
    };
  }
}
```

(The loading of these fields is done in Task 4 — for now this only widens the type. Existing assignments to `req.user` will fail to typecheck until Task 4; that is expected and Task 4 fixes them. If you need the build green between tasks, do Task 2 + Task 4 back-to-back before running `tsc`.)

- [ ] **Step 2: Write the failing middleware test**

`src/web/middleware/requirePermission.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { requirePermission, requireBotAccess } from "./requirePermission.js";

function appWith(user: any) {
  const app = express();
  app.use((req, _res, next) => { (req as any).user = user; next(); });
  app.post("/cap", requirePermission("quality"), (_req, res) => res.json({ ok: true }));
  app.post("/bot/:botId", requireBotAccess("botId"), (_req, res) => res.json({ ok: true }));
  return app;
}

const member = (caps: string[], bots: "all" | string[]) => ({
  id: "u1", username: "a", role: "member",
  capabilities: new Set(caps), bots: bots === "all" ? "all" : new Set(bots),
});
const admin = { id: "a", username: "admin", role: "admin", capabilities: new Set(), bots: "all" };

describe("requirePermission", () => {
  it("401 when unauthenticated", async () => {
    const app = express();
    app.post("/cap", requirePermission("quality"), (_r, res) => res.json({ ok: true }));
    expect((await request(app).post("/cap")).status).toBe(401);
  });
  it("403 when member lacks the capability", async () => {
    expect((await request(appWith(member([], "all"))).post("/cap")).status).toBe(403);
  });
  it("200 when member has the capability", async () => {
    expect((await request(appWith(member(["quality"], "all"))).post("/cap")).status).toBe(200);
  });
  it("200 for admin regardless of capabilities", async () => {
    expect((await request(appWith(admin)).post("/cap")).status).toBe(200);
  });
});

describe("requireBotAccess", () => {
  it("200 when bots = all", async () => {
    expect((await request(appWith(member([], "all"))).post("/bot/b1")).status).toBe(200);
  });
  it("200 when botId in allow-list", async () => {
    expect((await request(appWith(member([], ["b1"]))).post("/bot/b1")).status).toBe(200);
  });
  it("403 when botId not in allow-list", async () => {
    expect((await request(appWith(member([], ["b2"]))).post("/bot/b1")).status).toBe(403);
  });
  it("200 for admin", async () => {
    expect((await request(appWith(admin)).post("/bot/b1")).status).toBe(200);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/web/middleware/requirePermission.test.ts`
Expected: FAIL — module `./requirePermission.js` not found.

- [ ] **Step 4: Create `src/web/middleware/requirePermission.ts`**

```typescript
import type { Request, Response, NextFunction, RequestHandler } from "express";

export function requirePermission(capability: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (req.user.role === "admin" || req.user.capabilities.has(capability)) { next(); return; }
    res.status(403).json({ error: "forbidden" });
  };
}

export function requireBotAccess(paramName = "botId"): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (req.user.role === "admin" || req.user.bots === "all") { next(); return; }
    const botId = req.params[paramName];
    if (botId && req.user.bots.has(botId)) { next(); return; }
    res.status(403).json({ error: "forbidden" });
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/web/middleware/requirePermission.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/web/middleware/requirePermission.ts src/web/middleware/requirePermission.test.ts src/web/middleware/requireAuth.ts
git commit -m "feat(perm): requirePermission + requireBotAccess middleware"
```

---

## Task 3: Effective-permissions resolver (admin = all)

**Files:**
- Modify: `src/data/permissions.ts` (add `resolveContext` helper)
- Modify: `src/data/permissions.test.ts` (add tests)

- [ ] **Step 1: Add failing tests** to `src/data/permissions.test.ts`:

```typescript
import { resolvePermissionContext } from "./permissions.js";

describe("resolvePermissionContext", () => {
  it("admin gets all capabilities and all bots regardless of stored rows", () => {
    const store = createPermissionStore(db.db);
    const ctx = resolvePermissionContext("admin", "u1", store);
    expect([...ctx.capabilities].sort()).toEqual([...CAPABILITIES].sort());
    expect(ctx.bots).toBe("all");
  });
  it("member reflects stored capabilities + bot access", () => {
    const store = createPermissionStore(db.db);
    store.setPermissions("u1", { capabilities: ["player.control"], bots: ["b1"] });
    const ctx = resolvePermissionContext("member", "u1", store);
    expect([...ctx.capabilities]).toEqual(["player.control"]);
    expect(ctx.bots).toEqual(new Set(["b1"]));
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/data/permissions.test.ts`
Expected: FAIL — `resolvePermissionContext` not exported.

- [ ] **Step 3: Add to `src/data/permissions.ts`**

```typescript
export interface PermissionContext {
  capabilities: Set<string>;
  bots: "all" | Set<string>;
}

export function resolvePermissionContext(
  role: "admin" | "member",
  userId: string,
  store: PermissionStore
): PermissionContext {
  if (role === "admin") {
    return { capabilities: new Set(CAPABILITIES), bots: "all" };
  }
  const access = store.getBotAccess(userId);
  return {
    capabilities: new Set(store.getCapabilities(userId)),
    bots: access === "all" ? "all" : new Set(access),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/data/permissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/permissions.ts src/data/permissions.test.ts
git commit -m "feat(perm): resolvePermissionContext (admin = super-user)"
```

---

## Task 4: Load permissions onto req.user (requireAuth + session inline + /me)

**Files:**
- Modify: `src/web/middleware/requireAuth.ts`
- Modify: `src/web/api/session.ts`
- Modify: `src/web/server.ts`

- [ ] **Step 1: Thread `PermissionStore` into `createRequireAuth`**

`src/web/middleware/requireAuth.ts` — change the factory signature and set the new fields:

```typescript
import { resolvePermissionContext, type PermissionStore } from "../../data/permissions.js";

export function createRequireAuth(sessions: SessionStore, permissions: PermissionStore): RequestHandler {
  return function requireAuth(req, res, next) {
    const result = validateSessionFromHeaders(req.headers.cookie, sessions);
    if (!result) {
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const ctx = resolvePermissionContext(result.role, result.userId, permissions);
    req.user = {
      id: result.userId, username: result.username, role: result.role,
      capabilities: ctx.capabilities, bots: ctx.bots,
    };
    const token = extractSessionToken(req.headers.cookie);
    if (token) {
      res.cookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true, sameSite: "lax", secure: req.secure, path: "/", maxAge: SESSION_TTL_MS,
      });
    }
    next();
  };
}
```

- [ ] **Step 2: Update `src/web/server.ts`**

Construct the store next to the others and pass it in:

```typescript
import { createPermissionStore } from "../data/permissions.js";
// ...
const permissions = createPermissionStore(options.database.db);
// ...
const requireAuth = createRequireAuth(sessions, permissions);
```

Keep `permissions` in scope — it's passed to routers in Tasks 5–7.

- [ ] **Step 3: Update session inline auth + `/me` in `src/web/api/session.ts`**

`createSessionRouter` must accept `permissions` and (a) attach capabilities in `requireAuthInline`, (b) include them in `/me`. Pass `permissions` from `server.ts` into `createSessionRouter(users, sessions, audit, logger, permissions)`. In the `/me` handler, return:

```typescript
const ctx = resolvePermissionContext(validation.role, validation.userId, permissions);
res.json({
  id: validation.userId, username: validation.username, role: validation.role,
  capabilities: [...ctx.capabilities],
  bots: ctx.bots === "all" ? "all" : [...ctx.bots],
});
```

(Match the existing `/me` shape; just add `capabilities` + `bots`. Read the file to find the exact response object.)

- [ ] **Step 4: Verify build + existing tests**

Run: `npx tsc --noEmit`
Expected: exit 0 (the widened `req.user` is now populated everywhere it's read).

Run: `npx vitest run src/web`
Expected: PASS (existing auth/session/csrf tests still green; if a test constructs `createRequireAuth(sessions)` it must be updated to pass a `createPermissionStore(db)`).

- [ ] **Step 5: Commit**

```bash
git add src/web/middleware/requireAuth.ts src/web/server.ts src/web/api/session.ts
git commit -m "feat(perm): load capabilities + bot access onto req.user; expose via /me"
```

---

## Task 5: Enforce capabilities on the action routes

**Files:**
- Modify: `src/web/api/player.ts`, `src/web/api/bot.ts`, `src/web/api/auth.ts`, `src/web/api/music.ts`
- Modify: `src/web/api/player.test.ts` (or create `src/web/api/permissions-enforcement.test.ts`)

- [ ] **Step 1: Write a failing integration test** at `src/web/api/permissions-enforcement.test.ts` that builds the real app (or the relevant router) with a stubbed `req.user` and asserts:
  - member without `player.control` → `POST /api/player/:botId/pause` → 403
  - member with `player.control` + bot in allow-list → 200 (bot resolves)
  - member with `player.control` but bot NOT in allow-list → 403
  - member without `player.queue` → `POST /api/player/:botId/clear` → 403
  - member without `bot.manage` → `POST /api/bot` → 403
  - member without `platform.auth` → `POST /api/auth/cookie` → 403
  - member without `quality` → `POST /api/music/quality` → 403
  - admin → all 200/allowed

  Use the same `appWith(user)` injection pattern as Task 2 (insert a middleware that sets `req.user` before the router) and a fake `BotManager`/providers so routes resolve. Model it on the existing `src/web/api/*.test.ts` setup (read one first for the harness).

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/web/api/permissions-enforcement.test.ts` → FAIL (routes currently allow everyone).

- [ ] **Step 3: Apply gates.**

`src/web/api/player.ts` — the shared `/:botId` middleware already resolves the bot. Add bot-access there, and add per-action capability guards. Define the queue-capability routes vs control routes:

```typescript
import { requirePermission, requireBotAccess } from "../middleware/requirePermission.js";

// after the existing router.use("/:botId", resolveBot):
router.use("/:botId", requireBotAccess("botId"));

const control = requirePermission("player.control");
const queue = requirePermission("player.queue");
// control: play, pause, resume, next, prev, stop, seek, volume, mode, play-song, play-at, play-by-id, play-playlist, play-album, play-next-song
// queue:   add, add-song, add-by-id, clear, playlist, /queue/:index (DELETE)
// Apply per route, e.g.:
router.post("/:botId/pause", control, async (req, res) => { /* existing */ });
router.post("/:botId/add", queue, async (req, res) => { /* existing */ });
router.delete("/:botId/queue/:index", queue, async (req, res) => { /* existing */ });
```

(Insert the `control`/`queue` middleware as the 2nd arg of each existing `router.post/delete`. Do not change handler bodies. `PUT /:botId/profile` → `requirePermission("bot.manage")`.)

`src/web/api/bot.ts` — gate management + per-bot:

```typescript
const manage = requirePermission("bot.manage");
router.post("/", manage, ...);                 // create (no botId)
router.put("/:id", manage, requireBotAccess("id"), ...);
router.delete("/:id", manage, requireBotAccess("id"), ...);
router.post("/:id/start", manage, requireBotAccess("id"), ...);
router.post("/:id/stop", manage, requireBotAccess("id"), ...);
router.put("/:id/avatar", manage, requireBotAccess("id"), ...);
router.delete("/:id/avatar", manage, requireBotAccess("id"), ...);
router.post("/settings", manage, ...);         // global idle timeout
```

`src/web/api/auth.ts` — gate every mutating route with `requirePermission("platform.auth")`:
`POST /qrcode`, `POST /sms/send`, `POST /sms/verify`, `POST /cookie`. (Leave `GET /status`, `GET /qrcode/status` open — read-only.)

`src/web/api/music.ts` — gate the one mutating route:
`router.post("/quality", requirePermission("quality"), ...)`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/web/api/permissions-enforcement.test.ts` → PASS. Then `npx vitest run src/web` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/web/api/player.ts src/web/api/bot.ts src/web/api/auth.ts src/web/api/music.ts src/web/api/permissions-enforcement.test.ts
git commit -m "feat(perm): enforce capabilities + bot access on action routes"
```

---

## Task 6: Filter the bot list for members

**Files:**
- Modify: `src/web/api/bot.ts` (`GET /`)
- Modify: `src/bot/manager.ts` (`removeBot` → `permissions.pruneBot`)
- Modify: test from Task 5

- [ ] **Step 1: Add failing test** — member with `bots: ["b1"]` calling `GET /api/bot` sees only `b1`; admin sees all.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** In `GET /` of `bot.ts`:

```typescript
const all = getAllBots().map((b) => b.getStatus());
const u = req.user!;
const bots = u.role === "admin" || u.bots === "all"
  ? all
  : all.filter((b) => (u.bots as Set<string>).has(b.id));
res.json({ bots });
```

In `src/bot/manager.ts`, give `BotManager` access to the `PermissionStore` (constructor param) and call `this.permissions.pruneBot(id)` inside `removeBot(id)` after deletion, so deleted bots drop out of allow-lists. Thread `permissions` from `index.ts`/`server.ts` into `BotManager`.

- [ ] **Step 4: Run → pass; `npx vitest run src/web src/bot` green.**

- [ ] **Step 5: Commit**

```bash
git add src/web/api/bot.ts src/bot/manager.ts src/web/api/permissions-enforcement.test.ts
git commit -m "feat(perm): filter GET /api/bot to allowed bots; prune access on bot delete"
```

---

## Task 7: Management API (GET/PUT permissions) + audit

**Files:**
- Modify: `src/data/audit.ts` (add action)
- Modify: `src/web/api/users.ts` (+ permissions endpoints; new-member default)
- Modify: `src/web/server.ts` (pass `permissions` into `createUsersRouter`)
- Create/extend: `src/web/api/users.test.ts`

- [ ] **Step 1: Add `"user.permissions_changed"`** to the `AuditAction` union in `src/data/audit.ts`.

- [ ] **Step 2: Write failing tests** for the users router (admin-only):
  - `GET /api/users/:id/permissions` → `{ capabilities: [], bots: [] }` for a fresh member.
  - `PUT /api/users/:id/permissions` with `{capabilities:["player.control"], bots:"all"}` → 200; subsequent GET reflects it; an audit row `user.permissions_changed` exists.
  - `PUT` with an unknown capability token → it is dropped (not stored).
  - New member created via `POST /api/users` → GET permissions returns basic tier (`["player.control","player.queue"]`, bots `"all"`).

- [ ] **Step 3: Run → fail.**

- [ ] **Step 4: Implement** in `src/web/api/users.ts` (router already admin-gated at mount). Accept `permissions: PermissionStore` param. Add:

```typescript
import { CAPABILITIES, isCapability, BASIC_TIER_CAPABILITIES } from "../../data/permissions.js";

router.get("/:id/permissions", (req, res) => {
  const user = users.findById(req.params.id);
  if (!user) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ capabilities: permissions.getCapabilities(user.id), bots: permissions.getBotAccess(user.id) });
});

router.put("/:id/permissions", (req, res) => {
  const user = users.findById(req.params.id);
  if (!user) { res.status(404).json({ error: "not_found" }); return; }
  const body = req.body ?? {};
  const caps = Array.isArray(body.capabilities) ? body.capabilities.filter(isCapability) : [];
  const bots = body.bots === "all" ? "all" : (Array.isArray(body.bots) ? body.bots.map(String) : []);
  permissions.setPermissions(user.id, { capabilities: caps, bots });
  audit.record({
    actorId: req.user!.id, actorUsername: req.user!.username,
    targetUserId: user.id, targetUsername: user.username,
    action: "user.permissions_changed",
  });
  res.json({ success: true });
});
```

In the existing `POST /api/users` handler, after creating a member, seed the basic tier:

```typescript
if (created.role === "member") {
  permissions.setPermissions(created.id, { capabilities: BASIC_TIER_CAPABILITIES, bots: "all" });
}
```

- [ ] **Step 5: Run → pass; `npx vitest run src/web` green.**

- [ ] **Step 6: Commit**

```bash
git add src/data/audit.ts src/web/api/users.ts src/web/server.ts src/web/api/users.test.ts
git commit -m "feat(perm): admin permissions API + audit + new-member basic tier"
```

---

## Task 8: One-time migration backfill (existing members → full)

**Files:**
- Modify: `src/data/database.ts` (`migrateSchema` or a dedicated backfill)
- Create: `src/data/permissions-migration.test.ts`

- [ ] **Step 1: Write failing test** — given a fresh db with an existing `member` user and NO permission rows, after `createDatabase()` runs the backfill, that member has all 5 capabilities + `bots.all`; an `admin` user gets nothing (bypasses). Backfill is idempotent (running twice does not duplicate / does not re-grant a member who was later restricted to empty).

  Idempotency approach: store a one-shot marker. Use a `meta` row or check: only backfill members who currently have ZERO permission rows AND only on first introduction. Simplest robust marker: a row in a tiny `schema_meta(key TEXT PK, value TEXT)` table, key `perm_backfill_done`. If present, skip.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** a `backfillMemberPermissions(db)` run once inside `createDatabase` after `initTables`:

```typescript
db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)`);
const done = db.prepare("SELECT value FROM schema_meta WHERE key = 'perm_backfill_done'").get();
if (!done) {
  const members = db.prepare("SELECT id FROM users WHERE role = 'member'").all() as { id: string }[];
  const insCap = db.prepare("INSERT OR IGNORE INTO user_permissions (userId, permission) VALUES (?, ?)");
  const tx = db.transaction(() => {
    for (const m of members) {
      for (const c of ["player.control","player.queue","bot.manage","platform.auth","quality","bots.all"]) {
        insCap.run(m.id, c);
      }
    }
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('perm_backfill_done', ?)").run(String(Date.now()));
  });
  tx();
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git add src/data/database.ts src/data/permissions-migration.test.ts
git commit -m "feat(perm): one-time backfill of existing members to full access"
```

---

## Task 9: Frontend — session capabilities + helpers

**Files:**
- Modify: `web/src/composables/useSession.ts`

- [ ] **Step 1:** Extend the `User` type with `capabilities: string[]` and `bots: 'all' | string[]`; populate from `/api/session/me`, `/login`, `/setup` responses (the backend now returns them).
- [ ] **Step 2:** Add computed helpers:

```typescript
function can(cap: string): boolean {
  const u = currentUser.value;
  return !!u && (u.role === 'admin' || (u.capabilities ?? []).includes(cap));
}
function canControlBot(botId: string): boolean {
  const u = currentUser.value;
  if (!u) return false;
  if (u.role === 'admin' || u.bots === 'all') return true;
  return Array.isArray(u.bots) && u.bots.includes(botId);
}
```

Export `can` and `canControlBot` from the composable.

- [ ] **Step 3:** Manual check: log in as admin → `can('quality')` true; (after backend done) a restricted member → false. Build: `cd web && npx vue-tsc --noEmit`.
- [ ] **Step 4: Commit** `git add web/src/composables/useSession.ts && git commit -m "feat(perm): frontend session capabilities + can()/canControlBot()"`

---

## Task 10: Frontend — gate UI by capability + filter bots

**Files:**
- Modify: `web/src/components/Navbar.vue`, `web/src/components/Player.vue`, `web/src/views/Settings.vue`, `web/src/stores/player.ts`

- [ ] **Step 1:** Navbar bot selector: render only controllable bots — `v-for="bot in store.bots"` becomes a filtered computed `controllableBots = store.bots.filter(b => session.canControlBot(b.id))`. (The backend already filters `GET /api/bot`, so this is belt-and-suspenders + correctness if both lists diverge.) Ensure `store.activeBot` fallback never lands on a bot the user can't control.
- [ ] **Step 2:** Player.vue: wrap control buttons with `v-if="session.can('player.control')"` and queue actions with `v-if="session.can('player.queue')"`.
- [ ] **Step 3:** Settings.vue: wrap the platform login cards with `v-if="session.can('platform.auth')"`, the audio-quality control with `v-if="session.can('quality')"`, and bot create/edit/delete with `v-if="session.can('bot.manage')"`.
- [ ] **Step 4:** Manual verification (see Verification section). Build: `cd web && npx vue-tsc --noEmit`.
- [ ] **Step 5: Commit** `git add web/src/components/Navbar.vue web/src/components/Player.vue web/src/views/Settings.vue web/src/stores/player.ts && git commit -m "feat(perm): hide UI a member lacks capability for"`

---

## Task 11: Frontend — admin permission editor

**Files:**
- Modify: `web/src/views/Settings.vue` (User Management section)

- [ ] **Step 1:** In each member row of the admin User-Management list, add a "权限" button opening an editor (inline panel or dialog) with: 5 capability checkboxes (labels: 播放控制 / 队列管理 / 机器人管理 / 平台登录凭据 / 音质设置), and a bot allow-list — an "全部机器人" toggle plus, when off, a checkbox per bot from `store.bots`.
- [ ] **Step 2:** On open, `GET /api/users/:id/permissions`; on save, `PUT /api/users/:id/permissions` with `{capabilities, bots}` then re-fetch. Admin rows show "全部权限(管理员)" and no editor.
- [ ] **Step 3:** Manual verification. Build: `cd web && npx vue-tsc --noEmit`.
- [ ] **Step 4: Commit** `git add web/src/views/Settings.vue && git commit -m "feat(perm): admin permission editor in user management"`

---

## Final verification

- [ ] `npx tsc --noEmit` → exit 0
- [ ] `npx vitest run src/` → all green (clean-checkout-equivalent; ignore stale `dist/` twins — see note)
- [ ] `cd web && npx vue-tsc --noEmit` → exit 0
- [ ] `npm run build` → succeeds
- [ ] Manual (run the bot, log in): admin sees everything; create a member, restrict to `player.control` on one bot → member sees only that bot, can play/pause but cannot add to queue, cannot open platform login / quality / bot management; backend returns 403 on a forged request to a disallowed action (verify with curl + the member's session cookie).

> **Note (pre-existing):** `tsconfig.json` compiles `*.test.ts` into `dist/`, and vitest also runs the `dist/` twins after a build — so `npx vitest run` (no path) double-runs and can fail on stale artifacts. Scope verification to `npx vitest run src/`. (A separate cleanup PR could add `exclude: ['**/dist/**']` to a vitest config.)

## Out of scope (separate PRs, per spec)

#1 guest mode · #2 dedicated-link bot hiding UX · #3 auto-pause on empty channel · #4 dedicated-link refresh bug.
