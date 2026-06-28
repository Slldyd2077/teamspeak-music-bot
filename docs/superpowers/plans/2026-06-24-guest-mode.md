# Guest Mode (Login-less WebUI Access) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, default-off "guest mode" that lets an admin allow anonymous (no-login) visitors to use a restricted, per-permission-configurable subset of the WebUI.

**Architecture:** A guest is a synthetic, config-driven principal (`role: "guest"`) backed by one reserved DB user row, resolved per-request from `config.guestMode`. A single unified `authorize({capability, guestFlag})` middleware encapsulates admin/member/guest authorization, leaving the existing member/admin capability system behavior-unchanged. The append-vs-play-next queue split already exists; guest mode adds fine-grained admin toggles plus per-bot scope (enforced on REST and WebSocket).

**Tech Stack:** Node 20 + TypeScript (ESM, `.js` import specifiers), Express 5, better-sqlite3, `ws`, Vue 3 + Pinia + vue-router, Vitest + supertest.

## Global Constraints

- ESM project: all relative imports use the `.js` extension even from `.ts` files (e.g. `import { x } from "./permissions.js"`). Match this exactly.
- Backend tests run with `npx vitest run <file>`; the whole suite with `npm test`. Backend type-check: `npx tsc --noEmit`. Web type-check/build: `cd web && npx vue-tsc --noEmit`.
- The 7 guest permission flag names are fixed and identical everywhere (backend config, `GuestPermissions`, frontend, UI): `addToQueue`, `playNext`, `playNow`, `skip`, `transport`, `removeClear`, `playMode`.
- Default guest config (when first enabled): `enabled:false`, `bots:"all"`, permissions `{ addToQueue:true, playNext:false, playNow:false, skip:false, transport:false, removeClear:false, playMode:false }`.
- Guests are ALWAYS denied: settings view/write, bot management, platform auth, quality, user management, audit, change-password.
- Reserved guest principal: `GUEST_USER_ID = "__guest__"`, `GUEST_USERNAME = "游客"` (non-ASCII so the username can never be created via the API).
- Every `git commit` in this plan ends with the trailer line:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  (omitted from the per-step snippets below for brevity — add it to every commit).
- Branch: all work lands on `feat/guest-mode` (already created).

---

## File Structure

New files:
- `src/web/middleware/authorize.ts` — unified admin/member/guest gate.
- `src/web/middleware/requireNotGuest.ts` — allow admin+member, deny guest (for config reads).
- `src/web/middleware/authorize.test.ts`, `src/web/middleware/requireNotGuest.test.ts`.

Modified (backend): `src/data/config.ts` (+test), `src/data/permissions.ts` (+test), `src/data/users.ts` (+test), `src/data/sessions.ts` (+test), `src/data/database.ts` (+test), `src/web/middleware/requireAuth.ts` (+test), `src/web/api/session.ts` (+test), `src/web/api/player.ts`, `src/web/api/bot.ts` (+test), `src/web/api/music.ts`, `src/web/server.ts`, `src/web/websocket.ts` (+ `src/web/websocket-auth.test.ts`).

Modified (frontend): `web/src/composables/useSession.ts`, `web/src/router/index.ts`, `web/src/views/Login.vue`, `web/src/components/Navbar.vue`, `web/src/App.vue`, `web/src/components/SongCard.vue`, `web/src/stores/player.ts`, `web/src/components/Player.vue`, `web/src/components/Queue.vue`, `web/src/views/Settings.vue`.

Docs: `README.md`.

---

## Task 1: Config schema — `guestMode` block + deep merge

**Files:**
- Modify: `src/data/config.ts`
- Test: `src/data/config.test.ts`

**Interfaces:**
- Produces: `GuestModeConfig { enabled: boolean; bots: BotAccess; permissions: GuestPermissions }`; `BotConfig.guestMode: GuestModeConfig`; `getDefaultConfig()` returns the default block; `loadConfig` deep-merges `guestMode` + `guestMode.permissions`.
- Consumes: `BotAccess`, `GuestPermissions` from `./permissions.js` (added in Task 2 — do Task 2 first if your toolchain type-checks on red; tests here only need the runtime shape, but the import must resolve, so **Task 2 must be committed before this compiles**). To keep each task green, implement **Task 2 first**, then this task. (Plan ordering: 2 → 1 is fine; they are presented 1 then 2 for readability but committed 2 then 1. If you prefer, do Task 2's `permissions.ts` type additions, then return here.)

- [ ] **Step 1: Write the failing test** — append to `src/data/config.test.ts`:

```ts
import { getDefaultConfig, loadConfig, saveConfig } from "./config.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("guestMode config", () => {
  it("defaults to disabled, all-bots, append-only", () => {
    const c = getDefaultConfig();
    expect(c.guestMode.enabled).toBe(false);
    expect(c.guestMode.bots).toBe("all");
    expect(c.guestMode.permissions).toEqual({
      addToQueue: true, playNext: false, playNow: false,
      skip: false, transport: false, removeClear: false, playMode: false,
    });
  });

  it("deep-merges a partial guestMode so missing sub-keys are back-filled", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsmb-cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ guestMode: { enabled: true, permissions: { playNext: true } } }));
    const c = loadConfig(p);
    expect(c.guestMode.enabled).toBe(true);
    expect(c.guestMode.bots).toBe("all"); // back-filled
    expect(c.guestMode.permissions.playNext).toBe(true);
    expect(c.guestMode.permissions.addToQueue).toBe(true); // back-filled default
    expect(c.guestMode.permissions.skip).toBe(false); // back-filled default
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/config.test.ts`
Expected: FAIL (`guestMode` undefined).

- [ ] **Step 3: Implement** — in `src/data/config.ts`:

Add the import at the top (after the existing `node:fs`/`node:path` imports):

```ts
import type { BotAccess, GuestPermissions } from "./permissions.js";
```

Add interfaces above `BotConfig`:

```ts
export interface GuestModeConfig {
  enabled: boolean;
  bots: BotAccess; // "all" | string[]
  permissions: GuestPermissions;
}
```

Add the field to `BotConfig` (after `trustProxy: boolean;`):

```ts
  guestMode: GuestModeConfig;
```

Add to the object returned by `getDefaultConfig()` (after `trustProxy: false,`):

```ts
    guestMode: {
      enabled: false,
      bots: "all",
      permissions: {
        addToQueue: true,
        playNext: false,
        playNow: false,
        skip: false,
        transport: false,
        removeClear: false,
        playMode: false,
      },
    },
```

Replace the body of `loadConfig` to deep-merge `guestMode`:

```ts
export function loadConfig(path: string): BotConfig {
  const defaults = getDefaultConfig();
  try {
    const raw = readFileSync(path, "utf-8");
    const partial = JSON.parse(raw) as Partial<BotConfig>;
    return {
      ...defaults,
      ...partial,
      guestMode: {
        ...defaults.guestMode,
        ...(partial.guestMode ?? {}),
        permissions: {
          ...defaults.guestMode.permissions,
          ...(partial.guestMode?.permissions ?? {}),
        },
      },
    };
  } catch {
    return defaults;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/data/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/config.ts src/data/config.test.ts
git commit -m "feat(config): add default-off guestMode block with deep-merge"
```

---

## Task 2: Permissions — guest types + `resolvePermissionContext` guest branch

**Files:**
- Modify: `src/data/permissions.ts`
- Test: `src/data/permissions.test.ts`

**Interfaces:**
- Produces: `GuestPermissions` interface; `GUEST_PERMISSION_FLAGS` readonly tuple; `GuestFlag` type; `PermissionContext.guest?: GuestPermissions`; `resolvePermissionContext(role, userId, store, guest?)` where `role: "admin" | "member" | "guest"` and `guest?: { bots: BotAccess; permissions: GuestPermissions }`.
- Consumes: existing `CAPABILITIES`, `BotAccess`, `PermissionStore`.

> Do this task **before** Task 1 compiles (Task 1 imports `GuestPermissions`/`BotAccess` from here).

- [ ] **Step 1: Write the failing test** — append to `src/data/permissions.test.ts`:

```ts
import { resolvePermissionContext, GUEST_PERMISSION_FLAGS } from "./permissions.js";

describe("resolvePermissionContext guest branch", () => {
  const noStore = {
    getCapabilities: () => [],
    getBotAccess: () => [] as string[],
    setPermissions: () => {},
    pruneBot: () => {},
  };

  it("guest has no member capabilities and exposes the guest permissions + bots", () => {
    const ctx = resolvePermissionContext("guest", "__guest__", noStore, {
      bots: ["bot1"],
      permissions: {
        addToQueue: true, playNext: false, playNow: false,
        skip: true, transport: false, removeClear: false, playMode: false,
      },
    });
    expect([...ctx.capabilities]).toEqual([]);
    expect(ctx.bots).toBeInstanceOf(Set);
    expect((ctx.bots as Set<string>).has("bot1")).toBe(true);
    expect(ctx.guest?.addToQueue).toBe(true);
    expect(ctx.guest?.skip).toBe(true);
  });

  it("guest with bots:'all' resolves to 'all'", () => {
    const ctx = resolvePermissionContext("guest", "__guest__", noStore, {
      bots: "all",
      permissions: {
        addToQueue: true, playNext: false, playNow: false,
        skip: false, transport: false, removeClear: false, playMode: false,
      },
    });
    expect(ctx.bots).toBe("all");
  });

  it("exposes the 7 canonical flags", () => {
    expect([...GUEST_PERMISSION_FLAGS].sort()).toEqual(
      ["addToQueue", "playMode", "playNext", "playNow", "removeClear", "skip", "transport"].sort()
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/permissions.test.ts`
Expected: FAIL (`GUEST_PERMISSION_FLAGS`/guest branch missing).

- [ ] **Step 3: Implement** — in `src/data/permissions.ts`:

After the `BotAccess` type declaration, add:

```ts
export interface GuestPermissions {
  addToQueue: boolean;
  playNext: boolean;
  playNow: boolean;
  skip: boolean;
  transport: boolean;
  removeClear: boolean;
  playMode: boolean;
}

export const GUEST_PERMISSION_FLAGS = [
  "addToQueue",
  "playNext",
  "playNow",
  "skip",
  "transport",
  "removeClear",
  "playMode",
] as const;
export type GuestFlag = (typeof GUEST_PERMISSION_FLAGS)[number];
```

Add `guest` to `PermissionContext`:

```ts
export interface PermissionContext {
  capabilities: Set<string>;
  bots: "all" | Set<string>;
  guest?: GuestPermissions;
}
```

Replace `resolvePermissionContext` with:

```ts
export function resolvePermissionContext(
  role: "admin" | "member" | "guest",
  userId: string,
  store: PermissionStore,
  guest?: { bots: BotAccess; permissions: GuestPermissions }
): PermissionContext {
  if (role === "admin") {
    return { capabilities: new Set(CAPABILITIES), bots: "all" };
  }
  if (role === "guest") {
    const bots = guest?.bots ?? [];
    return {
      capabilities: new Set<string>(),
      bots: bots === "all" ? "all" : new Set(bots),
      guest: guest?.permissions,
    };
  }
  const access = store.getBotAccess(userId);
  return {
    capabilities: new Set(store.getCapabilities(userId)),
    bots: access === "all" ? "all" : new Set(access),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/data/permissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/permissions.ts src/data/permissions.test.ts
git commit -m "feat(permissions): guest permission types + resolve guest branch"
```

---

## Task 3: Users — `guest` role, reserved constants, exclude guests from count/list

**Files:**
- Modify: `src/data/users.ts`
- Test: `src/data/users.test.ts`

**Interfaces:**
- Produces: `UserRole = "admin" | "member" | "guest"`; `GUEST_USER_ID = "__guest__"`; `GUEST_USERNAME = "游客"`; `countUsers()` and `listUsers()` exclude `role='guest'`.
- Consumes: existing `UserStore`.

- [ ] **Step 1: Write the failing test** — append to `src/data/users.test.ts` (adapt the helper that builds a DB to match the existing file; the existing tests already create a `db` + `createUserStore` — reuse that setup):

```ts
import { GUEST_USER_ID, GUEST_USERNAME } from "./users.js";

describe("guest row exclusion", () => {
  it("countUsers and listUsers ignore the reserved guest row", async () => {
    const db = makeTestDb(); // however the existing tests build an in-memory DB with the users table
    const users = createUserStore(db);
    await users.createUser("alice", "password123", "member");
    // Insert the reserved guest row directly (mirrors the migration).
    db.prepare(
      "INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES (?, ?, ?, ?, ?, 'guest')"
    ).run(GUEST_USER_ID, GUEST_USERNAME, "!", Date.now(), Date.now());

    expect(users.countUsers()).toBe(1); // alice only
    expect(users.listUsers().some((u) => u.id === GUEST_USER_ID)).toBe(false);
  });
});
```

> If `src/data/users.test.ts` has no shared `makeTestDb`, copy the DB-bootstrapping lines used by the existing `describe` blocks in that file (they create a `better-sqlite3` DB and run the `users` `CREATE TABLE`). Keep the table definition identical to `initTables`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/users.test.ts`
Expected: FAIL (`GUEST_USER_ID` undefined / guest counted).

- [ ] **Step 3: Implement** — in `src/data/users.ts`:

Change the role type:

```ts
export type UserRole = "admin" | "member" | "guest";
```

Add constants under it:

```ts
/** Reserved synthetic principal for login-less guest sessions. The username is
 *  non-ASCII so it can never collide with an API-created account (which is
 *  validated against ^[A-Za-z0-9_\-.]{3,32}$). */
export const GUEST_USER_ID = "__guest__";
export const GUEST_USERNAME = "游客";
```

Change `countStmt` and `listUsersStmt` to exclude guests:

```ts
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role != 'guest'");
```
```ts
  const listUsersStmt = db.prepare(
    "SELECT id, username, createdAt, role FROM users WHERE role != 'guest' ORDER BY createdAt ASC"
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/data/users.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/users.ts src/data/users.test.ts
git commit -m "feat(users): guest role + reserved guest principal, excluded from count/list"
```

---

## Task 4: Sessions — `guest` role, per-session TTL + cap bypass

**Files:**
- Modify: `src/data/sessions.ts`
- Test: `src/data/sessions.test.ts`

**Interfaces:**
- Produces: `SessionValidation.role: "admin" | "member" | "guest"`; `GUEST_SESSION_TTL_MS`; `createSession(userId, opts?: { ttlMs?: number; skipCap?: boolean })`.
- Consumes: existing `sessions` schema.

- [ ] **Step 1: Write the failing test** — append to `src/data/sessions.test.ts` (reuse the file's existing DB setup that creates `users` + `sessions` tables and a guest/user row):

```ts
import { GUEST_SESSION_TTL_MS, MAX_SESSIONS_PER_USER } from "./sessions.js";

describe("guest sessions", () => {
  it("skipCap lets more than MAX_SESSIONS_PER_USER coexist for one principal", () => {
    const db = makeSessionsTestDb(); // existing helper / inline setup
    // create a user row to satisfy the FK
    db.prepare("INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES ('__guest__','游客','!',?,?, 'guest')")
      .run(Date.now(), Date.now());
    const sessions = createSessionStore(db);
    const tokens = [];
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 3; i++) {
      tokens.push(sessions.createSession("__guest__", { ttlMs: GUEST_SESSION_TTL_MS, skipCap: true }).token);
    }
    // The first token must STILL validate (not evicted).
    expect(sessions.validateAndTouch(tokens[0])?.role).toBe("guest");
    const n = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE userId='__guest__'").get() as { n: number }).n;
    expect(n).toBe(MAX_SESSIONS_PER_USER + 3);
  });

  it("ttlMs sets a shorter expiry than the default", () => {
    const db = makeSessionsTestDb();
    db.prepare("INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES ('__guest__','游客','!',?,?, 'guest')")
      .run(Date.now(), Date.now());
    const sessions = createSessionStore(db);
    const { expiresAt } = sessions.createSession("__guest__", { ttlMs: GUEST_SESSION_TTL_MS, skipCap: true });
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + GUEST_SESSION_TTL_MS + 50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/sessions.test.ts`
Expected: FAIL (`GUEST_SESSION_TTL_MS` undefined / opts unsupported).

- [ ] **Step 3: Implement** — in `src/data/sessions.ts`:

Add a constant near the existing TTLs:

```ts
export const GUEST_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 1 day — guests are short-lived
```

Widen `SessionValidation`:

```ts
export interface SessionValidation {
  userId: string;
  username: string;
  role: "admin" | "member" | "guest";
}
```

Update the `createSession` signature in the `SessionStore` interface:

```ts
  createSession(userId: string, opts?: { ttlMs?: number; skipCap?: boolean }): { token: string; expiresAt: number };
```

Replace the `createSession` implementation:

```ts
    createSession(userId, opts) {
      const token = randomBytes(32).toString("base64url");
      const id = hashToken(token);
      const now = Date.now();
      const expiresAt = now + (opts?.ttlMs ?? SESSION_TTL_MS);
      const tx = db.transaction(() => {
        if (!opts?.skipCap) {
          const existing = (countForUserStmt.get(userId) as { n: number }).n;
          if (existing >= MAX_SESSIONS_PER_USER) {
            deleteOldestForUserStmt.run(userId, existing - MAX_SESSIONS_PER_USER + 1);
          }
        }
        insertStmt.run(id, userId, now, expiresAt, now);
      });
      tx();
      return { token, expiresAt };
    },
```

In `validateAndTouch`, widen the returned role cast:

```ts
      return { userId: row.userId, username: row.username, role: row.role as "admin" | "member" | "guest" };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/data/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/sessions.ts src/data/sessions.test.ts
git commit -m "feat(sessions): guest role + per-session TTL and cap bypass"
```

---

## Task 5: Database — create the reserved guest user row (idempotent migration)

**Files:**
- Modify: `src/data/database.ts`
- Test: `src/data/database.test.ts`

**Interfaces:**
- Produces: a guest row (`id='__guest__'`, `role='guest'`) inserted idempotently during `createDatabase`.
- Consumes: `GUEST_USER_ID`, `GUEST_USERNAME` from `./users.js`.

- [ ] **Step 1: Write the failing test** — append to `src/data/database.test.ts`:

```ts
import { GUEST_USER_ID } from "./users.js";

describe("guest principal migration", () => {
  it("creates exactly one reserved guest row, idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsmb-db-"));
    const p = join(dir, "t.db");
    const a = createDatabase(p); a.db.close();
    const b = createDatabase(p); // run again — must not duplicate
    const row = b.db.prepare("SELECT id, role FROM users WHERE id = ?").get(GUEST_USER_ID) as { id: string; role: string } | undefined;
    expect(row?.role).toBe("guest");
    const n = (b.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='guest'").get() as { n: number }).n;
    expect(n).toBe(1);
    b.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("guest row does not break first-run detection (countUsers excludes it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsmb-db2-"));
    const p = join(dir, "t.db");
    const d = createDatabase(p);
    const users = createUserStore(d.db);
    expect(users.countUsers()).toBe(0); // guest excluded → still needs setup
    d.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

> Match the existing `database.test.ts` imports (`mkdtempSync`, `tmpdir`, `join`, `rmSync`, `createDatabase`, `createUserStore`); add any that are missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/database.test.ts`
Expected: FAIL (no guest row).

- [ ] **Step 3: Implement** — in `src/data/database.ts`:

Add to the imports at the top:

```ts
import { GUEST_USER_ID, GUEST_USERNAME } from "./users.js";
```

Add a new function above `createDatabase`:

```ts
/**
 * Ensure the reserved guest principal exists. Idempotent via the PK on
 * `users.id`. This row only backs login-less guest sessions; it is excluded
 * from countUsers()/listUsers() so it never interferes with first-run setup
 * or the user-management UI, and holds an unusable password hash.
 */
export function ensureGuestUser(db: Database.Database): void {
  const now = Date.now();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES (?, ?, '!', ?, ?, 'guest')"
  ).run(GUEST_USER_ID, GUEST_USERNAME, now, now);
}
```

Wire it into `createDatabase` after `backfillMemberPermissions(db);`:

```ts
  backfillMemberPermissions(db);
  ensureGuestUser(db);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/data/database.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/database.ts src/data/database.test.ts
git commit -m "feat(db): seed reserved guest principal idempotently"
```

---

## Task 6: Middleware — `authorize` + `requireNotGuest`

**Files:**
- Create: `src/web/middleware/authorize.ts`, `src/web/middleware/requireNotGuest.ts`
- Test: `src/web/middleware/authorize.test.ts`, `src/web/middleware/requireNotGuest.test.ts`

**Interfaces:**
- Produces: `authorize<P>({ capability?: string; guestFlag?: GuestFlag }): RequestHandler<P>`; `requireNotGuest: RequestHandler`.
- Consumes: `req.user` shape `{ role, capabilities?, bots?, guest? }` (the `guest?` field is added to the augmentation in Task 7; for this task's tests, cast a fake `req`).

- [ ] **Step 1: Write the failing tests** — `src/web/middleware/authorize.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { authorize } from "./authorize.js";

function run(user: any, opts: any) {
  const req: any = { user };
  const res: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
  const next = vi.fn();
  authorize(opts)(req, res, next);
  return { res, next };
}

describe("authorize", () => {
  it("401 when unauthenticated", () => {
    const { res, next } = run(undefined, { capability: "player.queue" });
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it("admin always passes", () => {
    const { next } = run({ role: "admin" }, { capability: "bot.manage" });
    expect(next).toHaveBeenCalled();
  });
  it("member passes only with the capability", () => {
    expect(run({ role: "member", capabilities: new Set(["player.queue"]) }, { capability: "player.queue" }).next).toHaveBeenCalled();
    expect(run({ role: "member", capabilities: new Set() }, { capability: "player.queue" }).res.statusCode).toBe(403);
  });
  it("guest passes only when its flag is enabled", () => {
    expect(run({ role: "guest", guest: { playNext: true } }, { capability: "player.control", guestFlag: "playNext" }).next).toHaveBeenCalled();
    expect(run({ role: "guest", guest: { playNext: false } }, { capability: "player.control", guestFlag: "playNext" }).res.statusCode).toBe(403);
  });
  it("guest is denied on routes with no guestFlag (e.g. play-song)", () => {
    expect(run({ role: "guest", guest: { addToQueue: true } }, { capability: "player.control" }).res.statusCode).toBe(403);
  });
});
```

`src/web/middleware/requireNotGuest.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { requireNotGuest } from "./requireNotGuest.js";

function run(user: any) {
  const req: any = { user };
  const res: any = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
  const next = vi.fn();
  requireNotGuest(req, res, next);
  return { res, next };
}

describe("requireNotGuest", () => {
  it("401 when no user", () => { expect(run(undefined).res.statusCode).toBe(401); });
  it("403 for guests", () => { expect(run({ role: "guest" }).res.statusCode).toBe(403); });
  it("passes admins and members", () => {
    expect(run({ role: "admin" }).next).toHaveBeenCalled();
    expect(run({ role: "member" }).next).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/web/middleware/authorize.test.ts src/web/middleware/requireNotGuest.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement** — `src/web/middleware/authorize.ts`:

```ts
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { GuestFlag } from "../../data/permissions.js";

/**
 * Unified authorization gate.
 * - admin  → always allowed (unchanged from requirePermission)
 * - member → allowed iff it holds `capability` (unchanged from requirePermission)
 * - guest  → allowed iff `guestFlag` is set AND that flag is enabled in the
 *            guest's resolved permissions; a route with no `guestFlag` is
 *            denied to guests by default.
 * Generic over the route-param shape `P` for the same reason requirePermission is.
 */
export function authorize<P = Record<string, string>>(opts: {
  capability?: string;
  guestFlag?: GuestFlag;
}): RequestHandler<P> {
  return (req: Request<P>, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (user.role === "admin") { next(); return; }
    if (user.role === "guest") {
      if (opts.guestFlag && user.guest?.[opts.guestFlag]) { next(); return; }
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (opts.capability && user.capabilities?.has(opts.capability)) { next(); return; }
    res.status(403).json({ error: "forbidden" });
  };
}
```

`src/web/middleware/requireNotGuest.ts`:

```ts
import type { Request, Response, NextFunction } from "express";

/** Allow admins and members; deny login-less guests (used for config reads
 *  that must never leak to guests, e.g. GET /api/bot/settings, GET /api/music/quality). */
export function requireNotGuest(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: "unauthenticated" }); return; }
  if (req.user.role === "guest") { res.status(403).json({ error: "forbidden" }); return; }
  next();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/web/middleware/authorize.test.ts src/web/middleware/requireNotGuest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/middleware/authorize.ts src/web/middleware/requireNotGuest.ts src/web/middleware/authorize.test.ts src/web/middleware/requireNotGuest.test.ts
git commit -m "feat(mw): add unified authorize() gate and requireNotGuest"
```

---

## Task 7: `requireAuth` — guest-aware `req.user`, disable→401, server wiring

**Files:**
- Modify: `src/web/middleware/requireAuth.ts`, `src/web/server.ts`
- Test: `src/web/middleware/requireAuth.test.ts`

**Interfaces:**
- Produces: `req.user` augmentation widened to `role: "admin" | "member" | "guest"` + `guest?: GuestPermissions`; `createRequireAuth(sessions, permissions, getGuestConfig: () => GuestModeConfig)`.
- Consumes: `resolvePermissionContext` (Task 2), `GuestModeConfig` (Task 1), `GuestPermissions` (Task 2).

- [ ] **Step 1: Write the failing test** — add cases to `src/web/middleware/requireAuth.test.ts` (reuse its existing harness that builds a fake `sessions`/`permissions`; if it stubs `validateSessionFromHeaders` via a fake `sessions.validateAndTouch`, follow that):

```ts
// A guest session is rejected (401) when guest mode is disabled.
it("rejects a guest session when guest mode is disabled", () => {
  const sessions: any = { validateAndTouch: () => ({ userId: "__guest__", username: "游客", role: "guest" }) };
  const permissions: any = { getCapabilities: () => [], getBotAccess: () => [] };
  const getGuestConfig = () => ({ enabled: false, bots: "all", permissions: {} as any });
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
  const perms = { addToQueue: true, playNext: false, playNow: false, skip: false, transport: false, removeClear: false, playMode: false };
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
```

> If `requireAuth.test.ts` currently constructs `createRequireAuth(sessions, permissions)` with two args, those existing calls must gain a third `getGuestConfig` arg — update them in this step.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/middleware/requireAuth.test.ts`
Expected: FAIL (3rd arg / guest handling missing).

- [ ] **Step 3: Implement** — replace `src/web/middleware/requireAuth.ts` with:

```ts
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { SessionStore } from "../../data/sessions.js";
import { SESSION_TTL_MS } from "../../data/sessions.js";
import { resolvePermissionContext, type PermissionStore, type GuestPermissions } from "../../data/permissions.js";
import type { GuestModeConfig } from "../../data/config.js";
import {
  validateSessionFromHeaders,
  extractSessionToken,
  SESSION_COOKIE_NAME,
} from "../auth/validateSession.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: {
      id: string;
      username: string;
      role: "admin" | "member" | "guest";
      capabilities?: Set<string>;
      bots?: "all" | Set<string>;
      guest?: GuestPermissions;
    };
  }
}

export function createRequireAuth(
  sessions: SessionStore,
  permissions: PermissionStore,
  getGuestConfig: () => GuestModeConfig
): RequestHandler {
  return function requireAuth(req: Request, res: Response, next: NextFunction) {
    const result = validateSessionFromHeaders(req.headers.cookie, sessions);
    if (!result) {
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    // A guest session is only valid while guest mode is enabled. Disabling it
    // immediately invalidates any in-flight guest sessions.
    const guestCfg = getGuestConfig();
    if (result.role === "guest" && !guestCfg.enabled) {
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const ctx = resolvePermissionContext(
      result.role,
      result.userId,
      permissions,
      result.role === "guest" ? { bots: guestCfg.bots, permissions: guestCfg.permissions } : undefined
    );
    req.user = {
      id: result.userId,
      username: result.username,
      role: result.role,
      capabilities: ctx.capabilities,
      bots: ctx.bots,
      guest: ctx.guest,
    };
    const token = extractSessionToken(req.headers.cookie);
    if (token) {
      res.cookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.secure,
        path: "/",
        maxAge: SESSION_TTL_MS,
      });
    }
    next();
  };
}
```

In `src/web/server.ts`, update the `createRequireAuth` call:

```ts
  const requireAuth = createRequireAuth(sessions, permissions, () => options.config.guestMode);
```

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run src/web/middleware/requireAuth.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors. (If `tsc` flags the `createSessionRouter` call in server.ts, that's fixed in Task 8 — you may temporarily expect that one error until Task 8; prefer doing Task 8 immediately after.)

- [ ] **Step 5: Commit**

```bash
git add src/web/middleware/requireAuth.ts src/web/middleware/requireAuth.test.ts src/web/server.ts
git commit -m "feat(auth): guest-aware requireAuth + disable invalidates guest sessions"
```

---

## Task 8: Session router — guest endpoint, `guestAllowed`, guest `/me`

**Files:**
- Modify: `src/web/api/session.ts`, `src/web/server.ts`
- Test: `src/web/api/session.test.ts`

**Interfaces:**
- Produces: `createSessionRouter(users, sessions, audit, logger, permissions, getGuestConfig)`; `POST /api/session/guest`; `GET /api/session/needs-setup` now returns `{ needsSetup, guestAllowed }`; `GET /api/session/me` returns `{ ..., role, capabilities, bots, guest }`.
- Consumes: `GUEST_USER_ID`, `GUEST_USERNAME` (Task 3), `GUEST_SESSION_TTL_MS` (Task 4), `GuestModeConfig` (Task 1).

- [ ] **Step 1: Write the failing test** — add to `src/web/api/session.test.ts` (this file already uses supertest with a mounted session router; mirror its setup, passing the new `getGuestConfig` arg):

```ts
// helper in this file builds: app.use("/api/session", createSessionRouter(users, sessions, audit, logger, permissions, getGuestConfig))
it("POST /guest is 403 when guest mode disabled", async () => {
  const { app } = makeApp({ guestEnabled: false });
  const res = await request(app).post("/api/session/guest");
  expect(res.status).toBe(403);
});

it("POST /guest mints a guest session when enabled, and /me reports role guest + flags", async () => {
  const { app } = makeApp({ guestEnabled: true, guestPermissions: { addToQueue: true, playNext: true, playNow: false, skip: false, transport: false, removeClear: false, playMode: false }, guestBots: "all" });
  const login = await request(app).post("/api/session/guest");
  expect(login.status).toBe(200);
  expect(login.body.role).toBe("guest");
  const cookie = login.headers["set-cookie"];
  const me = await request(app).get("/api/session/me").set("Cookie", cookie);
  expect(me.body.role).toBe("guest");
  expect(me.body.guest.addToQueue).toBe(true);
  expect(me.body.guest.playNext).toBe(true);
  expect(me.body.capabilities).toEqual([]);
});

it("GET /needs-setup exposes guestAllowed", async () => {
  const { app } = makeApp({ guestEnabled: true });
  const res = await request(app).get("/api/session/needs-setup");
  expect(res.body.guestAllowed).toBe(true);
});
```

> Implement `makeApp({...})` in the test using the existing helpers: a real DB via `createDatabase`, the stores, and a `getGuestConfig` returning `{ enabled, bots, permissions }` from the options. The guest row exists because `createDatabase` calls `ensureGuestUser`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/api/session.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `src/web/api/session.ts`:

Update imports:

```ts
import { SESSION_TTL_MS, GUEST_SESSION_TTL_MS } from "../../data/sessions.js";
import { GUEST_USER_ID, GUEST_USERNAME } from "../../data/users.js";
import type { GuestModeConfig } from "../../data/config.js";
```

Add the `getGuestConfig` parameter to the factory:

```ts
export function createSessionRouter(
  users: UserStore,
  sessions: SessionStore,
  audit: AuditStore,
  logger: Logger,
  permissions: PermissionStore,
  getGuestConfig: () => GuestModeConfig
): Router {
```

Update `/needs-setup`:

```ts
  router.get("/needs-setup", (_req, res) => {
    res.json({ needsSetup: users.countUsers() === 0, guestAllowed: getGuestConfig().enabled });
  });
```

Add the guest login route (place it next to `/login`, in the public part of the router — the whole session router is mounted before `requireAuth`/`csrf`):

```ts
  router.post("/guest", (_req, res) => {
    const cfg = getGuestConfig();
    if (!cfg.enabled) {
      res.status(403).json({ error: "guest mode disabled" });
      return;
    }
    const { token } = sessions.createSession(GUEST_USER_ID, { ttlMs: GUEST_SESSION_TTL_MS, skipCap: true });
    setSessionCookie(res, token);
    res.json({ id: GUEST_USER_ID, username: GUEST_USERNAME, role: "guest" });
  });
```

Update `/me` to resolve guest permissions and include them:

```ts
  router.get("/me", requireAuthInline, (req, res) => {
    const user = req.user!;
    const cfg = getGuestConfig();
    const ctx = resolvePermissionContext(
      user.role,
      user.id,
      permissions,
      user.role === "guest" ? { bots: cfg.bots, permissions: cfg.permissions } : undefined
    );
    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      capabilities: [...ctx.capabilities],
      bots: ctx.bots === "all" ? "all" : [...ctx.bots],
      guest: ctx.guest ?? null,
    });
  });
```

In `src/web/server.ts`, pass the getter to the session router:

```ts
  app.use("/api/session", createSessionRouter(users, sessions, audit, logger, permissions, () => options.config.guestMode));
```

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run src/web/api/session.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/web/api/session.ts src/web/server.ts src/web/api/session.test.ts
git commit -m "feat(session): guest login endpoint, guestAllowed, guest /me payload"
```

---

## Task 9: Player routes — unified gate + non-destructive guest play-now

**Files:**
- Modify: `src/web/api/player.ts`
- Test: `src/web/api/permissions-enforcement.test.ts` (add a guest describe block)

**Interfaces:**
- Produces: guest-reachable player routes gated by `authorize`; new `POST /:botId/play-now-song` (guestFlag `playNow`, non-destructive).
- Consumes: `authorize` (Task 6).

- [ ] **Step 1: Write the failing test** — append a guest block to `src/web/api/permissions-enforcement.test.ts` (it already mounts the real player router with an injected `req.user`; add a helper to inject a guest user and assert per-flag allow/deny). Example shape:

```ts
describe("guest enforcement on player routes", () => {
  // mountPlayer(injectUser) builds an express app: app.use((req,_res,n)=>{req.user=injectUser();n();}); app.use("/api/player", createPlayerRouter(...mockBotManager...))
  const guest = (perms: Partial<Record<string, boolean>>) => () => ({ id: "__guest__", role: "guest", bots: "all", guest: { addToQueue: false, playNext: false, playNow: false, skip: false, transport: false, removeClear: false, playMode: false, ...perms } });

  it("addToQueue flag gates POST /add, /add-song, /add-by-id", async () => {
    const allow = mountPlayer(guest({ addToQueue: true }));
    const deny = mountPlayer(guest({ addToQueue: false }));
    expect((await request(allow).post("/api/player/bot1/add-song").send({ song: SONG })).status).not.toBe(403);
    expect((await request(deny).post("/api/player/bot1/add-song").send({ song: SONG })).status).toBe(403);
  });

  it("playNext flag gates /play-next-song; playNow gates /play-now-song; skip gates /next", async () => {
    expect((await request(mountPlayer(guest({ playNext: true }))).post("/api/player/bot1/play-next-song").send({ song: SONG })).status).not.toBe(403);
    expect((await request(mountPlayer(guest({}))).post("/api/player/bot1/play-next-song").send({ song: SONG })).status).toBe(403);
    expect((await request(mountPlayer(guest({ playNow: true }))).post("/api/player/bot1/play-now-song").send({ song: SONG })).status).not.toBe(403);
    expect((await request(mountPlayer(guest({ skip: true }))).post("/api/player/bot1/next")).status).not.toBe(403);
  });

  it("guests are always denied /play-song and /play-at regardless of flags", async () => {
    const all = mountPlayer(guest({ addToQueue: true, playNext: true, playNow: true, skip: true, transport: true, removeClear: true, playMode: true }));
    expect((await request(all).post("/api/player/bot1/play-song").send({ song: SONG })).status).toBe(403);
    expect((await request(all).post("/api/player/bot1/play-at").send({ index: 0 })).status).toBe(403);
  });

  it("members are unaffected (player.queue still gates /add-song)", async () => {
    const m = mountPlayer(() => ({ id: "u1", role: "member", capabilities: new Set(["player.queue"]), bots: "all" }));
    expect((await request(m).post("/api/player/bot1/add-song").send({ song: SONG })).status).not.toBe(403);
  });
});
```

> Use the file's existing bot-manager mock so handlers resolve a fake bot/queue. `SONG = { id: "1", platform: "netease", name: "x", artist: "y" }`. Assert on **403 vs not-403** (a 200/500 from the mock both prove the gate passed).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/api/permissions-enforcement.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `src/web/api/player.ts`:

Update the import (replace the `requirePermission` import line — keep `requireBotAccess`):

```ts
import { requireBotAccess } from "../middleware/requirePermission.js";
import { authorize } from "../middleware/authorize.js";
```

Replace the gate on each guest-reachable route (leave the handler bodies untouched). Map:

```ts
// /add, /add-song, /add-by-id  → addToQueue
router.post("/:botId/add", authorize({ capability: "player.queue", guestFlag: "addToQueue" }), /* ...existing handler... */);
router.post("/:botId/add-song", authorize({ capability: "player.queue", guestFlag: "addToQueue" }), /* ... */);
router.post("/:botId/add-by-id", authorize({ capability: "player.queue", guestFlag: "addToQueue" }), /* ... */);

// transport (pause/resume/seek/volume) → transport ; skip (next) → skip ; clear → removeClear
router.post("/:botId/pause", authorize({ capability: "player.control", guestFlag: "transport" }), simpleCommand("!pause"));
router.post("/:botId/resume", authorize({ capability: "player.control", guestFlag: "transport" }), simpleCommand("!resume"));
router.post("/:botId/next", authorize({ capability: "player.control", guestFlag: "skip" }), simpleCommand("!next"));
router.post("/:botId/prev", authorize({ capability: "player.control" }), simpleCommand("!prev")); // no guest prev
router.post("/:botId/stop", authorize({ capability: "player.control" }), simpleCommand("!stop")); // no guest stop
router.post("/:botId/clear", authorize({ capability: "player.queue", guestFlag: "removeClear" }), simpleCommand("!clear"));

// fm/mode → playMode ; volume/seek → transport
router.post("/:botId/fm", authorize({ capability: "player.control", guestFlag: "playMode" }), /* ...existing fm handler... */);
router.post("/:botId/volume", authorize({ capability: "player.control", guestFlag: "transport" }), /* ...existing volume handler... */);
router.post("/:botId/mode", authorize({ capability: "player.control", guestFlag: "playMode" }), /* ...existing mode handler... */);
router.post("/:botId/seek", authorize({ capability: "player.control", guestFlag: "transport" }), /* ...existing seek handler... */);

// remove a queue item → removeClear
router.delete("/:botId/queue/:index", authorize({ capability: "player.queue", guestFlag: "removeClear" }), /* ...existing handler... */);

// play-next-song → playNext
router.post("/:botId/play-next-song", authorize({ capability: "player.control", guestFlag: "playNext" }), /* ...existing handler... */);

// play-at and play-song keep NO guest flag (guests denied)
router.post("/:botId/play-at", authorize({ capability: "player.control" }), /* ...existing handler... */);
router.post("/:botId/play-song", authorize({ capability: "player.control" }), /* ...existing handler... */);
```

> Do these as careful in-place edits: change ONLY the middleware argument (`requirePermission("X")` → `authorize({ capability: "X"[, guestFlag: "..."] })`). Leave every handler body exactly as-is. There may be additional `requirePermission(...)` routes in this file not listed here (e.g. play-playlist/play-album) — convert each to `authorize({ capability: "<same token>" })` with **no** guestFlag so members/admins are unchanged and guests stay denied.

Add the new non-destructive guest play-now route immediately after the `play-next-song` route:

```ts
  // Play a song "now" without clearing the queue: insert after current, then
  // promote to current and start it. Non-destructive (unlike /play-song which
  // clears the whole queue) — this is the guest-safe "play now".
  router.post("/:botId/play-now-song", authorize({ capability: "player.control", guestFlag: "playNow" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
      const queue = bot.getQueueManager();
      const insertedAt =
        queue.getCurrentIndex() < 0 ? queue.size() : queue.getCurrentIndex() + 1;
      queue.addNext(song);
      queue.playAt(insertedAt);
      bot.getPlayer().resetFailures();
      const ok = await bot.resolveAndPlay(queue.current()!);
      if (!ok) {
        res.json({ ok: false, message: `无法播放「${song.name || song.id}」（区域/版权限制）` });
        return;
      }
      res.json({ ok: true, message: `正在播放：${song.name || "Unknown"} - ${song.artist || "Unknown"}` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
```

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run src/web/api/permissions-enforcement.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/api/player.ts src/web/api/permissions-enforcement.test.ts
git commit -m "feat(player): unified authorize() gating + non-destructive guest play-now"
```

---

## Task 10: Bot settings — lock reads from guests + persist `guestMode`

**Files:**
- Modify: `src/web/api/bot.ts`
- Test: `src/web/api/bot.test.ts`

**Interfaces:**
- Produces: `GET /api/bot/settings` gated by `requireNotGuest` and now returns `guestMode`; `POST /api/bot/settings` (admin via `bot.manage`) accepts and validates a `guestMode` block.
- Consumes: `requireNotGuest` (Task 6), `GUEST_PERMISSION_FLAGS` (Task 2).

- [ ] **Step 1: Write the failing test** — add to `src/web/api/bot.test.ts` (mirror its existing settings tests; inject `req.user` as guest/admin):

```ts
it("GET /settings is 403 for guests and includes guestMode for admins", async () => {
  const guestApp = mountBot(() => ({ role: "guest", guest: {} }));
  expect((await request(guestApp).get("/api/bot/settings")).status).toBe(403);
  const adminApp = mountBot(() => ({ role: "admin" }));
  const res = await request(adminApp).get("/api/bot/settings");
  expect(res.status).toBe(200);
  expect(res.body.guestMode).toBeDefined();
  expect(res.body.guestMode.enabled).toBe(false);
});

it("POST /settings persists a guestMode block", async () => {
  const adminApp = mountBot(() => ({ role: "admin" }));
  const res = await request(adminApp).post("/api/bot/settings").send({
    guestMode: { enabled: true, bots: ["bot1"], permissions: { playNext: true } },
  });
  expect(res.status).toBe(200);
  expect(res.body.guestMode.enabled).toBe(true);
  expect(res.body.guestMode.bots).toEqual(["bot1"]);
  expect(res.body.guestMode.permissions.playNext).toBe(true);
  expect(res.body.guestMode.permissions.addToQueue).toBe(true); // untouched default
});
```

> `mountBot(injectUser)` builds an app injecting `req.user`, with a `config` object from `getDefaultConfig()` and a temp `configPath`; it mounts `createBotRouter(...)`. Reuse the existing helper if present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/api/bot.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `src/web/api/bot.ts`:

Update imports:

```ts
import { requirePermission, requireBotAccess } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";
import { GUEST_PERMISSION_FLAGS } from "../../data/permissions.js";
```

Gate the GET and extend its response:

```ts
  router.get("/settings", requireNotGuest, (_req, res) => {
    res.json({
      idleTimeoutMinutes: config.idleTimeoutMinutes ?? 0,
      autoPauseOnEmpty: config.autoPauseOnEmpty,
      guestMode: config.guestMode,
    });
  });
```

Extend the POST handler to accept `guestMode` (keep the existing idle/autoPause logic; add the guestMode parsing before `saveConfig`):

```ts
  router.post("/settings", requirePermission("bot.manage"), (req, res) => {
    const { idleTimeoutMinutes, autoPauseOnEmpty, guestMode } = req.body;

    const hasIdle = idleTimeoutMinutes !== undefined;
    if (hasIdle && (typeof idleTimeoutMinutes !== "number" || idleTimeoutMinutes < 0)) {
      res.status(400).json({ error: "idleTimeoutMinutes must be a non-negative number" });
      return;
    }
    const hasAutoPause = typeof autoPauseOnEmpty === "boolean";

    if (hasIdle) config.idleTimeoutMinutes = idleTimeoutMinutes;
    if (hasAutoPause) config.autoPauseOnEmpty = autoPauseOnEmpty;

    if (guestMode !== undefined && guestMode !== null && typeof guestMode === "object") {
      const gm = config.guestMode;
      if (typeof guestMode.enabled === "boolean") gm.enabled = guestMode.enabled;
      if (guestMode.bots === "all") {
        gm.bots = "all";
      } else if (Array.isArray(guestMode.bots)) {
        gm.bots = guestMode.bots.filter((id: unknown): id is string => typeof id === "string");
      }
      if (guestMode.permissions && typeof guestMode.permissions === "object") {
        for (const f of GUEST_PERMISSION_FLAGS) {
          if (typeof guestMode.permissions[f] === "boolean") {
            gm.permissions[f] = guestMode.permissions[f];
          }
        }
      }
    }

    saveConfig(configPath, config);

    for (const bot of botManager.getAllBots()) {
      if (hasIdle) bot.updateIdleTimeout(config.idleTimeoutMinutes);
      if (hasAutoPause) bot.updateAutoPause(config.autoPauseOnEmpty);
    }

    res.json({
      idleTimeoutMinutes: config.idleTimeoutMinutes ?? 0,
      autoPauseOnEmpty: config.autoPauseOnEmpty,
      guestMode: config.guestMode,
    });
  });
```

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run src/web/api/bot.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/api/bot.ts src/web/api/bot.test.ts
git commit -m "feat(bot): lock settings reads from guests + persist guestMode"
```

---

## Task 11: Music quality — lock reads from guests

**Files:**
- Modify: `src/web/api/music.ts`
- Test: `src/web/api/permissions-enforcement.test.ts` (or `music`-specific test if one exists)

**Interfaces:**
- Produces: `GET /api/music/quality` gated by `requireNotGuest`.
- Consumes: `requireNotGuest` (Task 6).

- [ ] **Step 1: Write the failing test** — add to the enforcement test (mount the music router with injected user):

```ts
it("GET /api/music/quality is 403 for guests, allowed for members", async () => {
  const guestApp = mountMusic(() => ({ role: "guest", guest: {} }));
  expect((await request(guestApp).get("/api/music/quality")).status).toBe(403);
  const memberApp = mountMusic(() => ({ role: "member", capabilities: new Set() }));
  expect((await request(memberApp).get("/api/music/quality")).status).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/api/permissions-enforcement.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `src/web/api/music.ts`:

Update import:

```ts
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";
```

Gate the quality read:

```ts
  router.get("/quality", requireNotGuest, (_req, res) => {
    res.json({
      netease: neteaseProvider.getQuality(),
      qq: qqProvider.getQuality(),
      bilibili: bilibiliProvider.getQuality(),
    });
  });
```

> Search/browse GET routes in this file stay open (guests need them to find songs).

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run src/web/api/permissions-enforcement.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/api/music.ts src/web/api/permissions-enforcement.test.ts
git commit -m "feat(music): lock quality read from guests"
```

---

## Task 12: WebSocket — per-bot scope for guests

**Files:**
- Modify: `src/web/server.ts`, `src/web/websocket.ts`
- Test: `src/web/websocket-auth.test.ts`

**Interfaces:**
- Produces: the upgrade handler stamps `(ws).isGuest` and `(ws).botScope` (`"all" | Set<string>`); `setupWebSocket` filters `init` and per-bot broadcasts so guests only see in-scope bots.
- Consumes: `options.config.guestMode` for the guest scope; member/admin behavior unchanged.

- [ ] **Step 1: Write the failing test** — add to `src/web/websocket-auth.test.ts` a test that a guest WS connection's `init` only includes in-scope bots. If the existing harness only tests the upgrade accept/reject, add a focused `setupWebSocket` unit test in the same file:

```ts
import { setupWebSocket } from "./websocket.js";

it("guest init is filtered to the guest bot scope", () => {
  const sent: any[] = [];
  const fakeWs: any = { readyState: 1, isGuest: true, botScope: new Set(["bot1"]), send: (m: string) => sent.push(JSON.parse(m)), on: () => {} };
  const fakeWss: any = { on: (ev: string, cb: any) => { if (ev === "connection") fakeWss._conn = cb; } };
  const botManager: any = {
    getAllBots: () => [{ id: "bot1", getStatus: () => ({ id: "bot1" }) }, { id: "bot2", getStatus: () => ({ id: "bot2" }) }],
    on: () => {}, off: () => {},
  };
  const cleanup = setupWebSocket(fakeWss, botManager, { debug() {}, error() {}, info() {}, warn() {} } as any);
  fakeWss._conn(fakeWs);
  const init = sent.find((m) => m.type === "init");
  expect(init.bots.map((b: any) => b.id)).toEqual(["bot1"]);
  cleanup();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/websocket-auth.test.ts`
Expected: FAIL (no filtering).

- [ ] **Step 3: Implement**

In `src/web/server.ts`, inside the `server.on("upgrade", ...)` handler, after `const result = validateSessionFromHeaders(...)` and its null-check, and before `wss.handleUpgrade`, add a guest-disabled guard and compute the scope:

```ts
    // Guest sessions are only valid while guest mode is enabled.
    if (result.role === "guest" && !options.config.guestMode.enabled) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const guestBots = options.config.guestMode.bots;
    const botScope: "all" | Set<string> =
      result.role === "guest"
        ? guestBots === "all" ? "all" : new Set(guestBots)
        : "all";
```

Then stamp the ws in the `handleUpgrade` callback:

```ts
    wss.handleUpgrade(req, socket, head, (ws) => {
      const w = ws as unknown as { userId: string; isGuest: boolean; botScope: "all" | Set<string> };
      w.userId = result.userId;
      w.isGuest = result.role === "guest";
      w.botScope = botScope;
      wss.emit("connection", ws, req);
    });
```

In `src/web/websocket.ts`:

Add a scope helper and use it in the connection handler's `init`:

```ts
  function visibleToClient(ws: WebSocket, botId: string): boolean {
    const w = ws as unknown as { isGuest?: boolean; botScope?: "all" | Set<string> };
    if (!w.isGuest || w.botScope === "all" || !w.botScope) return true;
    return w.botScope.has(botId);
  }
```

Replace the `init` build in the connection handler:

```ts
  wss.on("connection", (ws) => {
    clients.add(ws);
    logger.debug("WebSocket client connected");

    const bots = botManager
      .getAllBots()
      .filter((b) => visibleToClient(ws, b.id))
      .map((b) => b.getStatus());
    ws.send(JSON.stringify({ type: "init", bots }));
    // ... keep the existing close/error handlers ...
  });
```

Change `broadcast` to take an optional `botId` and filter per client:

```ts
  const broadcast = (data: object, botId?: string) => {
    const message = JSON.stringify(data);
    for (const client of clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (botId !== undefined && !visibleToClient(client, botId)) continue;
      try {
        client.send(message);
      } catch {
        clients.delete(client);
      }
    }
  };
```

Pass the botId at each call site:

```ts
    // onStateChange:
      broadcast({ type: "stateChange", botId: bot.id, status: bot.getStatus(), queue: bot.getQueue() }, bot.id);
    // onConnected:
      broadcast({ type: "botConnected", botId: bot.id, status: bot.getStatus() }, bot.id);
    // onDisconnected:
      broadcast({ type: "botDisconnected", botId: bot.id, status: bot.getStatus() }, bot.id);
    // onBotInstanceRemoved:
      broadcast({ type: "botRemoved", botId: id }, id);
```

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run src/web/websocket-auth.test.ts && npx tsc --noEmit`
Expected: PASS. Member/admin clients (`isGuest=false`) receive everything as before.

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts src/web/websocket.ts src/web/websocket-auth.test.ts
git commit -m "feat(ws): scope guest WebSocket feed to allowed bots"
```

---

## Task 13: Frontend session composable — guest surface

**Files:**
- Modify: `web/src/composables/useSession.ts`

**Interfaces:**
- Produces: `User.role: 'admin'|'member'|'guest'`; `User.guest?: Record<string, boolean> | null`; `guestAllowed` ref; `isGuest` computed; `guestCan(flag)`; `continueAsGuest()`.
- Consumes: `/api/session/needs-setup` (`guestAllowed`), `/api/session/guest`, `/api/session/me` (`guest`).

- [ ] **Step 1: Implement** (frontend has no unit harness for this composable; verify by type-check/build). Edit `web/src/composables/useSession.ts`:

Widen `User`:

```ts
interface User {
  id: string;
  username: string;
  role: 'admin' | 'member' | 'guest';
  capabilities?: string[];
  bots?: "all" | string[];
  guest?: Record<string, boolean> | null;
}
```

Add a `guestAllowed` ref near `needsSetup`:

```ts
const guestAllowed = ref(false);
```

In `refreshNeedsSetup`, also capture `guestAllowed`:

```ts
async function refreshNeedsSetup(): Promise<void> {
  const res = await fetch("/api/session/needs-setup", { credentials: "same-origin" });
  if (res.ok) {
    const body = await res.json();
    needsSetup.value = Boolean(body.needsSetup);
    guestAllowed.value = Boolean(body.guestAllowed);
  }
}
```

Add a `continueAsGuest` action (after `login`):

```ts
async function continueAsGuest(): Promise<void> {
  const res = await fetch("/api/session/guest", { method: "POST", credentials: "same-origin" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `guest entry failed (${res.status})`);
  }
  currentUser.value = (await res.json()) as User;
  await refreshMe(); // authoritative role + guest flags + bots
}
```

Add helpers near `can`:

```ts
function guestCan(flag: string): boolean {
  const u = currentUser.value;
  return !!u && u.role === "guest" && !!u.guest && u.guest[flag] === true;
}
```

Export the new surface from `useSession()`:

```ts
  return {
    currentUser: readonly(currentUser),
    needsSetup: readonly(needsSetup),
    guestAllowed: readonly(guestAllowed),
    isAuthenticated: computed(() => currentUser.value !== null),
    isAdmin: computed(() => currentUser.value?.role === 'admin'),
    isGuest: computed(() => currentUser.value?.role === 'guest'),
    ready: readonly(ready),
    refresh,
    login,
    logout,
    setup,
    continueAsGuest,
    can,
    guestCan,
    canControlBot,
  };
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/composables/useSession.ts
git commit -m "feat(web/session): expose isGuest, guestCan, continueAsGuest, guestAllowed"
```

---

## Task 14: Router — block guests from settings/setup

**Files:**
- Modify: `web/src/router/index.ts`

**Interfaces:**
- Consumes: `session.isGuest`.

- [ ] **Step 1: Implement** — in `web/src/router/index.ts`, inside `beforeEach`, after the `!session.isAuthenticated.value` redirect block, add:

```ts
  // Guests may never reach settings/setup, even by typing the URL.
  const GUEST_BLOCKED = new Set(['settings', 'setup']);
  if (session.isGuest.value && GUEST_BLOCKED.has(to.name as string)) {
    return { name: 'home' };
  }
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/router/index.ts
git commit -m "feat(web/router): block guests from settings and setup routes"
```

---

## Task 15: Login — "Continue as guest" button

**Files:**
- Modify: `web/src/views/Login.vue`

**Interfaces:**
- Consumes: `session.guestAllowed`, `session.continueAsGuest`.

- [ ] **Step 1: Implement** — in `web/src/views/Login.vue`, add the button after the `</form>` close (still inside `.auth-page`), and a handler.

Template (insert after the `<form>` element, before `</div>`):

```vue
      <button
        v-if="session.guestAllowed.value"
        type="button"
        class="guest-btn"
        :disabled="loading"
        @click="enterAsGuest"
      >
        以游客身份进入
      </button>
```

Script (add the handler next to `submit`):

```ts
async function enterAsGuest() {
  error.value = '';
  loading.value = true;
  try {
    await session.continueAsGuest();
    const rawNext = typeof route.query.next === 'string' ? route.query.next : '/';
    const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
    router.replace(next);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
```

Style (append inside the `<style scoped>` block):

```scss
.guest-btn {
  height: 38px; margin-top: 4px; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-secondary);
  border: 1px solid var(--border-color); cursor: pointer;
}
.guest-btn:hover { color: var(--text-primary); }
.guest-btn:disabled { opacity: 0.6; cursor: progress; }
```

> Note `.auth-card` is the `<form>`; place the guest button as a sibling after it so it sits below the card, or move it inside the form before `</form>` if you prefer it within the card. Either is fine; match the card width visually.

- [ ] **Step 2: Type-check**

Run: `cd web && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/views/Login.vue
git commit -m "feat(web/login): add Continue as guest entry when guest mode is on"
```

---

## Task 16: Navbar — hide settings cog + guest role badge

**Files:**
- Modify: `web/src/components/Navbar.vue`

**Interfaces:**
- Consumes: `session.isGuest`, `session.currentUser`.

- [ ] **Step 1: Implement** — in `web/src/components/Navbar.vue`:

Gate the settings cog:

```vue
      <RouterLink v-if="!session.isGuest.value" to="/settings" class="settings-btn">
        <Icon icon="mdi:cog" />
      </RouterLink>
```

Update the role badge to render a guest label (replace the existing badge `<span>`):

```vue
        <span class="nav-user-role" :class="`role-${session.currentUser.value.role}`">
          {{ session.currentUser.value.role === 'admin' ? '管理员' : session.currentUser.value.role === 'guest' ? '游客' : '成员' }}
        </span>
```

(Optionally add a `.role-guest` color in the `<style>` mirroring `.role-member`.)

- [ ] **Step 2: Type-check**

Run: `cd web && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Navbar.vue
git commit -m "feat(web/navbar): hide settings cog for guests + 游客 badge"
```

---

## Task 17: App shell — hide mobile settings tab for guests

**Files:**
- Modify: `web/src/App.vue`

**Interfaces:**
- Consumes: `useSession().isGuest`.

- [ ] **Step 1: Implement** — in `web/src/App.vue`:

Add the import + usage in `<script setup>` (App.vue currently does NOT use the session):

```ts
import { useSession } from './composables/useSession.js';
const session = useSession();
```

Gate the mobile settings tab:

```vue
      <RouterLink v-if="!session.isGuest.value" to="/settings" class="m-tab" :class="{ active: route.path.startsWith('/settings') }">
        <Icon icon="mdi:cog" class="tab-icon" />
        <span class="tab-label">设置</span>
      </RouterLink>
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/App.vue
git commit -m "feat(web/app): hide mobile settings tab for guests"
```

---

## Task 18: SongCard — gate play/playNext/add buttons

**Files:**
- Modify: `web/src/components/SongCard.vue`

**Interfaces:**
- Consumes: `useSession().can`, `useSession().guestCan`.

- [ ] **Step 1: Implement** — in `web/src/components/SongCard.vue`:

Add to `<script setup>` (after the existing imports):

```ts
import { computed } from 'vue';
import { useSession } from '../composables/useSession.js';

const { can, guestCan } = useSession();
const showPlay = computed(() => can('player.control') || guestCan('playNow'));
const showPlayNext = computed(() => can('player.control') || guestCan('playNext'));
const showAdd = computed(() => can('player.queue') || guestCan('addToQueue'));
```

Gate the root double-click and each button:

```vue
  <div class="song-card" :class="{ active }" @dblclick="showPlay && $emit('play')">
```
```vue
    <div class="song-actions">
      <button v-if="showPlay" class="action-btn" @click.stop="$emit('play')" title="播放">
        <Icon icon="mdi:play" />
      </button>
      <button v-if="showPlayNext" class="action-btn" @click.stop="$emit('playNext')" title="下一首播放">
        <Icon icon="mdi:playlist-play" />
      </button>
      <button v-if="showAdd" class="action-btn" @click.stop="$emit('add')" title="添加到队列">
        <Icon icon="mdi:playlist-plus" />
      </button>
    </div>
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/SongCard.vue
git commit -m "feat(web/songcard): gate play/playNext/add by member capability or guest flag"
```

---

## Task 19: Player store — guest-aware non-destructive play-now

**Files:**
- Modify: `web/src/stores/player.ts`

**Interfaces:**
- Produces: `playSong` posts to `/play-now-song` for guests, `/play-song` otherwise.
- Consumes: `useSession().isGuest`.

- [ ] **Step 1: Implement** — in `web/src/stores/player.ts`:

Add the import at the top (with the other imports):

```ts
import { useSession } from '../composables/useSession.js';
```

Replace `playSong`:

```ts
    async playSong(song: Song) {
      if (!this.activeBotId) return;
      // Guests use the non-destructive "play now" (insert-next + skip) so they
      // can't wipe everyone else's queue; members/admins keep the normal behavior.
      const endpoint = useSession().isGuest.value ? 'play-now-song' : 'play-song';
      const res = await axios.post(`/api/player/${this.activeBotId}/${endpoint}`, { song });
      if (res.data?.ok === false && res.data?.message) {
        this.notify(res.data.message, 'error');
      }
      this._setTiming(this.activeBotId, { serverElapsed: 0 });
      this._syncAfterAction();
    },
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx vue-tsc --noEmit`
Expected: no errors. (No import cycle: `useSession.ts` imports nothing from the store.)

- [ ] **Step 3: Commit**

```bash
git add web/src/stores/player.ts
git commit -m "feat(web/store): route guest play to non-destructive play-now-song"
```

---

## Task 20: Player bar — per-button gating for guests

**Files:**
- Modify: `web/src/components/Player.vue`

**Interfaces:**
- Consumes: `useSession().can`, `useSession().guestCan`.

- [ ] **Step 1: Implement** — in `web/src/components/Player.vue`:

Add computeds after `const canControl = computed(() => can('player.control'));`:

```ts
const { can, guestCan } = useSession();
const canControl = computed(() => can('player.control'));
const canTransport = computed(() => can('player.control') || guestCan('transport'));
const canSkip = computed(() => can('player.control') || guestCan('skip'));
const canModeCtl = computed(() => can('player.control') || guestCan('playMode'));
```

Replace the transport `<template v-if="canControl">` block (the prev/play-pause/next/mode group) with per-button gating:

```vue
        <template v-if="canControl || canTransport || canSkip || canModeCtl">
          <button v-if="canControl" class="control-btn" @click="store.prev()">
            <Icon icon="mdi:skip-previous" />
          </button>
          <button v-if="canTransport" class="play-btn" @click="togglePlay">
            <Icon :icon="store.isPlaying ? 'mdi:pause' : 'mdi:play'" />
          </button>
          <button v-if="canSkip" class="control-btn" @click="store.next()">
            <Icon icon="mdi:skip-next" />
          </button>
          <button v-if="canModeCtl" class="control-btn mode-btn" @click="cycleMode" :title="modeLabel">
            <Icon :icon="modeIcon" />
            <span class="mode-label">{{ modeLabel }}</span>
          </button>
        </template>
```

Replace the volume `<template v-if="canControl">` with `canTransport`:

```vue
        <template v-if="canTransport">
          <Icon icon="mdi:volume-high" class="volume-icon" />
          <input
            type="range"
            min="0"
            max="100"
            :value="activeBot?.volume ?? 75"
            @change="onVolumeChange"
            class="volume-slider"
          />
        </template>
```

Change the seek gating to use `canTransport` (the `:class` and the handler):

```vue
        :class="{ 'no-seek': !canTransport }"
```
And in the script `onProgressClick`:
```ts
  if (!canTransport.value) return;
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Player.vue
git commit -m "feat(web/player): per-button transport gating honoring guest flags"
```

---

## Task 21: Queue panel — remove/clear gating for guests

**Files:**
- Modify: `web/src/components/Queue.vue`

**Interfaces:**
- Consumes: `useSession().can`, `useSession().guestCan`.

- [ ] **Step 1: Implement** — in `web/src/components/Queue.vue`:

Destructure `guestCan`:

```ts
const { can, guestCan } = useSession();
```

Gate the clear/stop header button:

```vue
      <button
        v-if="botQueue.length > 0 && (can('player.control') || guestCan('removeClear'))"
        class="clear-btn"
        @click="clearAndStop"
        title="清空队列并停止播放"
      >
        <Icon icon="mdi:stop-circle-outline" />
      </button>
```

Gate the per-item remove button:

```vue
        <button v-if="can('player.queue') || guestCan('removeClear')" class="remove-btn" @click="removeSong(i)" title="移除">
          <Icon icon="mdi:close" />
        </button>
```

> Leave `playAtIndex`'s `if (!can('player.control')) return;` guard as-is — there is no guest flag for jump-to-index, so guests can't double-click-to-play-at. (For a guest, the dblclick handler simply no-ops.)

- [ ] **Step 2: Type-check**

Run: `cd web && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Queue.vue
git commit -m "feat(web/queue): gate remove/clear by member capability or guest removeClear"
```

---

## Task 22: Settings — admin-only 游客模式 section

**Files:**
- Modify: `web/src/views/Settings.vue`

**Interfaces:**
- Consumes: `GET/POST /api/bot/settings` (now carrying `guestMode`); `session.isAdmin`; `store.bots`.

- [ ] **Step 1: Implement** — in `web/src/views/Settings.vue`:

**Script** — add state near the idle-timeout refs (around the `loadIdleTimeout`/`saveAutoPause` block):

```ts
// --- Guest mode (admin only) ---
const GUEST_FLAGS: { token: string; label: string }[] = [
  { token: 'addToQueue', label: '添加到队列末尾' },
  { token: 'playNext', label: '添加到下一首' },
  { token: 'playNow', label: '立即播放（不清空队列）' },
  { token: 'skip', label: '跳过当前歌曲' },
  { token: 'transport', label: '暂停/继续/进度/音量' },
  { token: 'removeClear', label: '移除/清空队列' },
  { token: 'playMode', label: '切换播放模式 / FM' },
];
const guestMode = reactive<{ enabled: boolean; botsAll: boolean; selectedBotIds: string[]; permissions: Record<string, boolean> }>({
  enabled: false,
  botsAll: true,
  selectedBotIds: [],
  permissions: { addToQueue: true, playNext: false, playNow: false, skip: false, transport: false, removeClear: false, playMode: false },
});
const guestSaving = ref(false);

function applyGuestModeFromServer(gm: any) {
  if (!gm) return;
  guestMode.enabled = Boolean(gm.enabled);
  guestMode.botsAll = gm.bots === 'all';
  guestMode.selectedBotIds = Array.isArray(gm.bots) ? [...gm.bots] : [];
  for (const f of GUEST_FLAGS) {
    guestMode.permissions[f.token] = Boolean(gm.permissions?.[f.token]);
  }
}

function toggleGuestBot(id: string, checked: boolean) {
  const has = guestMode.selectedBotIds.includes(id);
  if (checked && !has) guestMode.selectedBotIds.push(id);
  else if (!checked && has) guestMode.selectedBotIds = guestMode.selectedBotIds.filter((b) => b !== id);
}

async function saveGuestMode() {
  guestSaving.value = true;
  try {
    const res = await axios.post('/api/bot/settings', {
      guestMode: {
        enabled: guestMode.enabled,
        bots: guestMode.botsAll ? 'all' : [...guestMode.selectedBotIds],
        permissions: { ...guestMode.permissions },
      },
    });
    applyGuestModeFromServer(res.data?.guestMode);
  } catch { /* ignore */ } finally {
    guestSaving.value = false;
  }
}
```

Extend `loadIdleTimeout` to also hydrate guest mode (it already GETs `/api/bot/settings`):

```ts
async function loadIdleTimeout() {
  try {
    const res = await axios.get('/api/bot/settings');
    idleTimeout.value = res.data.idleTimeoutMinutes ?? 0;
    autoPauseOnEmpty.value = res.data.autoPauseOnEmpty ?? false;
    applyGuestModeFromServer(res.data.guestMode);
  } catch { /* ignore */ }
}
```

**Template** — insert a new admin-only section between the end of the 行为设置 section (`</section>` at the idle-timeout/auto-pause block) and the 机器人 Profile section:

```vue
    <!-- Guest Mode (admin only) -->
    <section v-if="session.isAdmin.value" class="settings-section">
      <h2 class="section-title">游客模式</h2>
      <p class="profile-section-hint">开启后，访客无需登录即可进入并点歌（默认关闭）。游客永远无法查看或修改设置。下面逐项决定游客可用的能力。</p>

      <label class="profile-toggle behavior-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">允许游客访问</div>
          <div class="profile-toggle-hint">登录页会出现「以游客身份进入」。关闭后所有游客会话立即失效。</div>
        </div>
        <input v-model="guestMode.enabled" type="checkbox" class="profile-toggle-switch" />
      </label>

      <div v-if="guestMode.enabled" class="perm-group">
        <div class="perm-group-title">游客权限</div>
        <div class="perm-checks">
          <label v-for="f in GUEST_FLAGS" :key="f.token" class="perm-check">
            <input type="checkbox" v-model="guestMode.permissions[f.token]" />
            {{ f.label }}
          </label>
        </div>
      </div>

      <div v-if="guestMode.enabled" class="perm-group">
        <div class="perm-group-title">可控制的机器人</div>
        <label class="perm-check">
          <input type="checkbox" v-model="guestMode.botsAll" />
          全部机器人
        </label>
        <div v-if="!guestMode.botsAll" class="perm-checks perm-bots">
          <label v-for="bot in store.bots" :key="bot.id" class="perm-check">
            <input
              type="checkbox"
              :checked="guestMode.selectedBotIds.includes(bot.id)"
              @change="toggleGuestBot(bot.id, ($event.target as HTMLInputElement).checked)"
            />
            {{ bot.name }}
          </label>
          <span v-if="store.bots.length === 0" class="user-empty">还没有机器人。</span>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn-primary" :disabled="guestSaving" @click="saveGuestMode">
          {{ guestSaving ? '保存中…' : '保存' }}
        </button>
      </div>
    </section>
```

> Reuses existing classes (`settings-section`, `profile-toggle`, `perm-group`, `perm-check`, `perm-checks`, `perm-bots`, `form-actions`, `btn-primary`) so no new CSS is required.

- [ ] **Step 2: Type-check + build**

Run: `cd web && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/views/Settings.vue
git commit -m "feat(web/settings): admin-only 游客模式 section (toggles + bot scope)"
```

---

## Task 23: README docs + full verification

**Files:**
- Modify: `README.md`
- Verify: whole repo

- [ ] **Step 1: Document** — add a "游客模式 / Guest mode" subsection to `README.md` near the existing permissions/WebUI auth docs, explaining: default-off; how to enable in 设置 → 游客模式; the 7 toggles; per-bot scope; that guests can't view/change settings; and that to reproduce "下一首 only" you disable 添加到队列末尾 and enable 添加到下一首. (Match the README's existing bilingual style.)

- [ ] **Step 2: Full backend test suite**

Run: `npm test`
Expected: all tests pass (including the new config/permissions/users/sessions/database/authorize/requireNotGuest/requireAuth/session/enforcement/bot/websocket tests).

- [ ] **Step 3: Full build (backend + web type-check + bundle)**

Run: `npm run build`
Expected: `tsc` clean, `vue-tsc --noEmit` clean, `vite build` succeeds.

- [ ] **Step 4: Manual smoke (optional but recommended — use the /run or /verify skill)**

Start the app, create/login admin, enable guest mode with only 添加到下一首 on and scope to one bot; open an incognito window, click 以游客身份进入, confirm: no settings cog/tab, only the 下一首 button appears on songs, other bots are not visible, and `POST /api/session/guest` returns 403 after toggling guest mode off.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document guest mode"
```

---

## Self-Review notes (author)

- **Spec coverage:** default-off (T1), guest principal/session entry (T3–T5, T8), unified gate (T6, T9), per-flag toggles incl. play-next/play-now/skip/transport/remove-clear/play-mode (T9, T18, T20–T22), non-destructive play-now (T9, T19), settings always-locked incl. ungated reads (T10–T11), per-bot scope on REST (T7 via `requireBotAccess` + `resolvePermissionContext`) and WS (T12), disable→logout (T7, T8, T12), frontend gating + entry + admin UI (T13–T22), tests throughout, README (T23). Reproducing issue #83's "下一首 only" = admin config (T22) — documented.
- **Ordering caveat:** Task 2 must be committed before Task 1 type-checks (Task 1 imports from `permissions.js`); Tasks 7 and 8 both edit `server.ts` and should be done back-to-back so `tsc` is green.
- **Type consistency:** flag names (`addToQueue`/`playNext`/`playNow`/`skip`/`transport`/`removeClear`/`playMode`) identical across `GuestPermissions`, `GUEST_PERMISSION_FLAGS`, config defaults, `authorize` guestFlag args, and the Settings UI. `role` union widened identically in `users.ts`, `sessions.ts`, `requireAuth.ts`, and the frontend `User`.
