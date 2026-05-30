# Fine-grained account permissions — design

**Issue:** [#79](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot/issues/79) (item E — the maintainer's permission-management idea)
**Date:** 2026-05-30
**Status:** Approved (brainstorm), pending implementation plan

## Scope

Issue #79 bundles five things. This spec covers **only item E**: allow an admin to
grant each non-admin (member) account a set of capabilities and a list of bots they
may control. The other items are handled in separate PRs and are **out of scope**
here:

- #1 Guest mode (login-less playback)
- #2 Dedicated-link hides other bots (subsumed conceptually by E's bot allow-list, but the link-specific UX is separate)
- #3 Auto-pause when channel empty
- #4 Dedicated link loses bot binding on refresh (a bug)

## Problem

Today the bot has a coarse two-role system: `admin | member` (single `role` column,
read live per request). `requireAdmin` gates only `/api/users` and `/api/audit`.
**Every other action — create/edit/delete bots, start/stop, all playback & queue
control, set platform login cookies, set audio quality — is open to any logged-in
member, on every bot.** Admins want to delegate limited control to members without
handing them full power.

## Decisions (from brainstorm)

1. **Model = capability flags + per-member bot allow-list** (not a per-bot×per-action
   matrix, not role templates).
2. **Defaults:** on upgrade, existing members are backfilled with full capabilities +
   all bots (no behavior change); newly-created members get a **basic tier**.
3. **Bot allow-list semantics:** an explicit "all bots" toggle OR a specific list;
   empty list = no bots controllable. Members **cannot see** bots outside their
   allow-list (hidden, not merely disabled).
4. **Capability set (5 toggles)** — see below; basic tier = playback + queue + all bots.
5. **Admin is a super-user** (bypasses all checks). The last admin cannot be demoted
   (existing invariant preserved). Permission grants/revokes are written to the
   existing audit log.

## Capability taxonomy

| Capability token | Covers | Scope |
|---|---|---|
| `player.control` | play/pause/resume/next/prev/stop/seek/volume/mode | per-bot (allow-list) |
| `player.queue` | search-add / clear / remove / play-at / playlist / album / play-song | per-bot (allow-list) |
| `bot.manage` | create / edit / delete / start / stop / avatar / profile / idle settings | global (create) + per-bot (operate a specific bot) |
| `platform.auth` | set NetEase/QQ/Bilibili cookie, QR, SMS | **global** (shared credentials) |
| `quality` | set audio quality per platform | **global** |

Bot scope is independent of capabilities: a member with `player.control` can only
exercise it on bots in their allow-list (or all, if the "all bots" flag is set).
`platform.auth` and `quality` are global capabilities with no bot scope.

**Basic tier** (new members): `{ player.control, player.queue }` + `bots.all = true`.
A new member can play/queue on every bot but cannot manage bots, change credentials,
or change quality.

## Data model (SQLite, additive — follows existing `CREATE TABLE IF NOT EXISTS` pattern)

```sql
-- capability tokens + the "all bots" flag (stored as token 'bots.all')
CREATE TABLE IF NOT EXISTS user_permissions (
  userId     TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (userId, permission),
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

-- specific bot allow-list (only consulted when 'bots.all' is NOT present)
CREATE TABLE IF NOT EXISTS user_bot_access (
  userId TEXT NOT NULL,
  botId  TEXT NOT NULL,
  PRIMARY KEY (userId, botId),
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_bot_access_userId ON user_bot_access(userId);
```

- Admins have no rows (they bypass). Only members are constrained.
- `bots.all` present ⇒ all bots (incl. future ones). Absent ⇒ only `user_bot_access`
  rows; empty ⇒ none.
- `foreign_keys = ON` and WAL are already enabled; cascade-on-user-delete works.
- `user_bot_access.botId` references bot instance ids; when a bot is deleted, its
  access rows should be cleaned up (either an FK to the bot table if one exists, or an
  explicit cleanup in `BotManager.removeBot` / `PermissionStore.pruneBot(botId)`).

New `PermissionStore` in `src/data/permissions.ts` (mirrors `createUserStore` /
`createSessionStore`: prepared statements + an interface). Methods:
`getCapabilities(userId)`, `getBotAccess(userId)` → `'all' | string[]`,
`setPermissions(userId, { capabilities, bots })`, `pruneBot(botId)`.

## Backend enforcement (real 403 — not just hidden UI)

- **`req.user` widened** to carry `capabilities: Set<string>` and bot access. Loaded in
  `requireAuth` (one extra lookup, or a JOIN in the session query). The same
  `{id,username,role,capabilities,bots}` shape must be kept in sync in the three places
  it is built today: `requireAuth.ts`, `session.ts` `requireAuthInline`, and the WS
  upgrade handler in `server.ts` (WS only needs it if a push action becomes gated).
  Because it's read live, permission changes take effect immediately (no re-login).
- **`requirePermission(cap)`** middleware (new, mirrors `requireAdmin.ts`): 401 if no
  user; allow if `role === 'admin'` or `capabilities.has(cap)`; else 403.
- **`requireBotAccess`** helper: allow if admin or `bots.all` or botId ∈ access list;
  else 403. Mounted on the player router's existing `/:botId` choke-point
  (`src/web/api/player.ts`) and on each `:id` route in `src/web/api/bot.ts`
  (start/stop/edit/delete/avatar/profile).
- **Route → capability mapping:**
  - `/api/player/:botId/*` playback actions → `player.control` (+ `requireBotAccess`)
  - `/api/player/:botId/*` queue actions → `player.queue` (+ `requireBotAccess`)
  - `/api/bot` create, `/api/bot/:id` edit/delete, `/api/bot/:id/start|stop|avatar|profile`, `/api/bot/settings` → `bot.manage` (+ `requireBotAccess` for the `:id` ones)
  - `/api/auth/*` (cookie/QR/SMS) → `platform.auth`
  - `/api/music/quality` POST → `quality`
- **`GET /api/bot`** filters its result to the caller's allowed bots for members
  (admins see all). This is what "hides" disallowed bots in the UI.

## Management API (admin-only, added to the existing users router)

- `GET /api/users/:id/permissions` → `{ capabilities: string[], bots: 'all' | string[] }`
- `PUT /api/users/:id/permissions` → body `{ capabilities, bots }`; validates tokens
  against the known set and botIds against existing bots; writes audit
  `user.permissions_changed`.
- `GET /api/session/me` is extended to include the **current** user's
  `{ capabilities, bots }` so the frontend can gate UI. (admins report effectively-all.)

## Frontend

- `useSession` extends `User` with `capabilities` + bot scope and exposes
  `can(cap)` and `canControlBot(botId)` helpers.
- **Navbar bot selector** filters `store.bots` to controllable bots (others hidden);
  `activeBot` fallback and `fetchBots` default only ever land on an allowed bot.
- **Player / Settings** hide controls and whole sections a member lacks: platform
  login, audio quality, and bot create/edit/delete are hidden without the matching
  capability; playback/queue buttons hidden without `player.control` / `player.queue`.
- **Admin permission editor:** in the Settings → User Management list, each member row
  gets a "权限" editor — capability checkboxes + a bot allow-list with an "全部机器人"
  toggle. Saving calls `PUT /api/users/:id/permissions`.

## Defaults & migration

- New tables created idempotently in `initTables`.
- **One-time backfill** (guarded so it runs once): every existing `member` gets all
  five capabilities + `bots.all`. Admins are skipped (they bypass). This preserves
  current behavior for existing members on upgrade.
- **New member default** (`POST /api/users` with role member): capabilities
  `{ player.control, player.queue }` + `bots.all` (basic tier).
- Pre-existing accounts default to `role = 'admin'` per the current schema — those are
  super-users and unaffected.

## Testing (TDD)

- `PermissionStore` unit tests (set/get capabilities + bot access; `'all'` vs list vs
  empty; `pruneBot`).
- `requirePermission` / `requireBotAccess` middleware tests (admin bypass; has/lacks
  cap → 200/403; bot in/out of allow-list; `bots.all`).
- API tests: member without cap → 403; with cap → 200; bot not allowed → 403/hidden;
  `GET /api/bot` filtered for members, full for admin; `PUT .../permissions` validates
  + audits.
- Migration test: existing members backfilled to full + `bots.all`; new member gets
  basic tier.

## Non-goals

- No per-bot×per-capability matrix, no custom role templates (YAGNI).
- Guest mode, dedicated-link UX, auto-pause, and the refresh bug (#1–#4) are separate.
- No change to the admin/member role concept itself; this layers capabilities under
  the existing `member` role.
