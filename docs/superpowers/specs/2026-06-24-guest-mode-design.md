# Guest mode (login-less WebUI access) — design

**Issue:** [#83](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot/issues/83) — "请求增加 WebUI 鉴权 guest 登录功能"
**Date:** 2026-06-24
**Status:** Approved (brainstorm), pending implementation plan

## Scope

Add an optional, **default-OFF** guest mode. When an admin enables it, anyone who can
reach the WebUI can enter **without logging in** ("以游客身份进入 / Continue as guest")
and use a restricted subset of playback/queue features. The admin chooses, per
deployment, exactly what guests may do (a set of toggles) and which bot(s) guests may
control. Guests can **never** view or change settings, manage bots, set platform
credentials, change audio quality, or see the user/audit admin panels.

This builds directly on the existing `admin | member` role + capability system
(`src/data/permissions.ts`, `requirePermission`, `useSession().can()`) and the existing
append-vs-play-next queue split (`PlayQueue.add` vs `addNext`). It does **not** rebuild
auth.

The original issue asked specifically that guest song requests go to "下一首" only.
That exact behavior is reproducible in this design by the admin turning the
"add to end" toggle **off** and the "play next" toggle **on** — it is one configuration
of a more general per-ability toggle model (chosen in brainstorm).

## Problem

Today every `/api/*` route past the session router requires a real account
(`requireAuth`). There is no anonymous/guest path: to let a friend queue a song, an
admin must create them a `member` account. The maintainer wants a low-friction,
admin-gated way to let untrusted visitors request music without an account, while
keeping all administration locked down.

## Decisions (from brainstorm)

1. **Guest = no-login.** A guest is an **anonymous, config-driven synthetic principal**
   (`role: "guest"`), not a database user with a password. No favorites, no
   change-password, short-lived session.
2. **Default OFF**, enforced **server-side** (the guest-session endpoint rejects when
   the flag is off — never rely on hiding the button).
3. **Per-ability toggles**, not a single "mode". Every song action and control action is
   its own admin switch. Default state when guest mode is first enabled: only
   "add to end of queue" is ON; everything else OFF.
4. **Per-bot guest scope** (`"all"` or an explicit bot list), mirroring the existing
   member bot allow-list. Guests cannot see or control out-of-scope bots — including
   over WebSocket.
5. **Settings are always hidden AND server-blocked for guests** (view + change), closing
   the two currently-ungated reads (`GET /api/bot/settings`, `GET /api/music/quality`).
6. **"Play now" for guests is non-destructive**: insert-next + skip to it, **never** the
   existing clear-the-whole-queue `/play-song` behavior.
7. **One unified authorization gate** encapsulates admin/member/guest logic so the
   existing member/admin capability system is left behavior-unchanged.

## Guest ability model

### Always allowed (baseline read-only — the point of the feature)
- Browse/search library, playlists, history, song detail, lyrics, cover art.
- See now-playing and the live queue (REST + WebSocket), **scoped to allowed bots**.

### Always denied (hard locks — not toggles)
- View **or** change any settings (idle timeout, auto-pause, theme persistence server-side, command prefix, etc.).
- Bot management (create/edit/delete/start/stop, bot config, avatar, profile).
- Music-platform login (`/api/auth/*`), audio quality (`/api/music/quality`).
- User management (`/api/users`), audit log (`/api/audit`), change-password.

### Admin-configurable toggles (`guestMode.permissions.*`, all default `false` except `addToQueue`)

| Flag | 中文 | Default | Backend route(s) gated |
|---|---|---|---|
| `addToQueue` | 添加到队列末尾 | **true** | `POST /:botId/add`, `/add-song`, `/add-by-id` |
| `playNext` | 添加到下一首 | false | `POST /:botId/play-next-song` |
| `playNow` | 立即播放（不清空队列） | false | new guest-safe play-now (insert-next + skip) |
| `skip` | 跳过当前歌曲 | false | `POST /:botId/next` |
| `transport` | 暂停/继续/进度/音量 | false | `POST /:botId/pause`, `/resume`, `/seek`, `/volume` |
| `removeClear` | 移除/清空队列 | false | `DELETE /:botId/queue/:index`, `POST /:botId/clear` |
| `playMode` | 切换播放模式 / FM | false | `POST /:botId/mode`, `/fm` |

Notes:
- Routes with **no** guest flag (e.g. `/prev`, `/stop`, `/play-song`, `/play-playlist`,
  `/play-album`, `/play-at`, all of `/api/bot/*`, `/api/auth/*`, settings, users, audit)
  are **never** reachable by guests — the gate denies any guest without an explicit flag.
  This is the safe default: new routes are guest-denied unless deliberately opted in.
- `/play-song`, `/play-playlist`, `/play-album` call `queue.clear()` and must stay
  guest-denied regardless of toggles (they would wipe everyone's queue).

## Config schema (`src/data/config.ts`)

```ts
export interface GuestPermissions {
  addToQueue: boolean;   // append to end
  playNext: boolean;     // 下一首 (insert after current)
  playNow: boolean;      // 立即播放: insert-next + skip-to-it (non-destructive)
  skip: boolean;         // skip current track
  transport: boolean;    // pause/resume/seek/volume
  removeClear: boolean;  // remove a queue item / clear the queue
  playMode: boolean;     // play mode (shuffle/repeat) + FM
}

export interface GuestModeConfig {
  enabled: boolean;          // master switch, default false
  bots: "all" | string[];    // per-bot scope (botIds); default "all"
  permissions: GuestPermissions;
}

// added to BotConfig:
guestMode: GuestModeConfig;
```

`getDefaultConfig()` returns:
```ts
guestMode: {
  enabled: false,
  bots: "all",
  permissions: {
    addToQueue: true, playNext: false, playNow: false,
    skip: false, transport: false, removeClear: false, playMode: false,
  },
}
```

**Merge hardening:** `loadConfig` currently does a shallow `{...defaults, ...partial}`,
which would drop `guestMode` sub-keys if a saved config only contains a partial
`guestMode`. `loadConfig` must **deep-merge `guestMode`** (and its `permissions`) over
the defaults so missing sub-keys are back-filled. Covered by a `config.test.ts` case.

**Bot deletion:** when a bot is removed, prune its id from `guestMode.bots` (if it's an
array) and persist — mirrors `PermissionStore.pruneBot(botId)` for members. Done in the
same `BotManager.removeBot` path that already prunes member access.

## Backend design

### Synthetic guest principal & session entry
- **Role union widened** to `"admin" | "member" | "guest"` (`UserRole` in
  `src/data/users.ts`, the `req.user` augmentation in `requireAuth.ts`, the frontend
  `User` type, and the role badge in Navbar).
- **Reserved guest user row.** A single fixed row (e.g. id `"__guest__"`, role `"guest"`,
  an unusable password hash, username e.g. `"guest"`) is created idempotently by
  migration. It exists only to satisfy the `sessions.userId` FK and the
  `validateAndTouch` JOIN; it is excluded from user-management listings and the
  last-admin guards (those count `role = 'admin'` only, so guests don't interfere).
- **Guest login endpoint:** `POST /api/session/guest`, mounted in the **public** block
  (before `csrfOriginCheck`/`requireAuth`, like `/login` and `/setup`), rate-limited.
  - If `config.guestMode.enabled` is false → `403 guest mode disabled`.
  - Else `sessions.createSession("__guest__")` and set the same `tsmb_session` httpOnly
    cookie. **Guest sessions use a short TTL** (e.g. `GUEST_SESSION_TTL_MS`, ~24h) and
    **bypass `MAX_SESSIONS_PER_USER`** for the guest principal (otherwise guest #11
    would evict guest #1). Expired guest sessions are already deleted on validation; an
    optional periodic sweep can prune stale ones.
- **Disable = logout.** In `createRequireAuth`/`validateSession`, if a validated session
  has `role === "guest"` but `config.guestMode.enabled` is now false, treat it as
  unauthenticated (401). So flipping guest mode off immediately ends guest access.
- **Expose availability:** extend `GET /api/session/needs-setup` (or add a sibling
  `GET /api/session/guest-config`) to return `guestAllowed: boolean` so the **public**
  Login page can decide whether to show the guest button. This must not leak any other
  config.

### Permission resolution
`resolvePermissionContext` gains a `guest` branch. Signature extended to receive the
live guest config:
```ts
resolvePermissionContext(role, userId, store, guestConfig?) => {
  admin  → { capabilities: all CAPABILITIES, bots: "all" }
  member → stored caps + stored bots            // unchanged
  guest  → {
    capabilities: new Set(),                     // holds NO member capabilities
    bots: guestConfig.bots === "all" ? "all" : new Set(guestConfig.bots),
    guest: guestConfig.permissions,              // resolved per-request from live config
  }
}
```
`PermissionContext` and `req.user` gain an optional `guest?: GuestPermissions`. Because
`req.user` is rebuilt per request, toggling a permission or the bot scope takes effect on
the guest's next request (no re-login).

### Unified authorization gate (`src/web/middleware/authorize.ts`, new)
Replaces `requirePermission('x')` on **guest-reachable** routes:
```ts
authorize({ capability?: Capability, guestFlag?: keyof GuestPermissions })
  // 401 if no req.user
  // admin  → next()
  // guest  → (req.user.guest?.[guestFlag] === true) ? next() : 403   // also 403 if no guestFlag
  // member → (capability && req.user.capabilities.has(capability)) ? next() : 403
```
- Member/admin semantics are **identical** to today's `requirePermission`.
- A route with no `guestFlag` is automatically guest-denied (safe default).
- `requireBotAccess` is unchanged and already enforces the guest `bots` scope (guests
  flow through `req.user.bots`).
- `requireAdmin` is unchanged (guests are non-admin → 403), so `/api/users` and
  `/api/audit` stay locked.

### Route changes (`src/web/api/player.ts`, `bot.ts`, `music.ts`)
- Re-express guest-reachable player routes via `authorize({ capability, guestFlag })`:
  - `/add`, `/add-song`, `/add-by-id` → `{ capability: "player.queue", guestFlag: "addToQueue" }`
  - `/play-next-song` → `{ capability: "player.control", guestFlag: "playNext" }`
    (members keep `player.control`; guests pass only via `playNext`)
  - new guest-safe **play-now** → `{ capability: "player.control", guestFlag: "playNow" }`
  - `/next` → `{ capability: "player.control", guestFlag: "skip" }`
  - `/pause`,`/resume`,`/seek`,`/volume` → `{ capability: "player.control", guestFlag: "transport" }`
  - `DELETE /queue/:index`, `/clear` → `{ capability: "player.queue", guestFlag: "removeClear" }`
  - `/mode`, `/fm` → `{ capability: "player.control", guestFlag: "playMode" }`
  - everything else stays `authorize({ capability })` (no guest flag) → guest-denied.
- **Guest-safe play-now**: a new behavior (own route, e.g. `POST /:botId/play-now`, or a
  `mode:"now"` branch) that does `queue.addNext(song)` then advances to it (skip into the
  inserted track) — **no `queue.clear()`**. Members/admins may also use it; the existing
  destructive `/play-song` stays for the normal ▶ in non-guest UI. Exact wiring decided
  in the plan.
- **Close ungated reads against guests:** `GET /api/bot/settings` and
  `GET /api/music/quality` currently have no guard, so a guest could read config. Add a
  small `requireNotGuest` guard (allow `admin` + `member`, deny `guest` → 403). This
  **does not change member/admin behavior** — members keep their current read access; only
  guests are newly denied. (Deliberately not a new member capability, to avoid touching
  member semantics.)

### WebSocket (`src/web/websocket.ts`, `src/web/server.ts`)
- Guests authenticate over the WS upgrade unchanged (session cookie). 
- **Add per-client bot-scope filtering** for guests: the upgrade handler already stamps
  `ws.userId`; also resolve and stamp the client's bot scope (`"all"` or a Set). In
  `setupWebSocket`, when sending `init` and broadcasting `stateChange` /
  `botConnected/Disconnected/Removed`, **filter to bots the client may see**. For guests
  with a scoped `bots` list, out-of-scope bots are omitted. Admin/member payloads are
  unchanged (they resolve to `"all"` or their existing member scope — to avoid changing
  member behavior, filtering may be applied **only when the client is a guest**; decided
  in the plan).

### Settings write (`POST /api/bot/settings`)
Extend the existing settings writer (today only idle-timeout + auto-pause) to also accept
and persist the `guestMode` block (admin-only via `bot.manage`/`requireAdmin`), calling
`saveConfig`. Live effect: subsequent guest requests read the updated in-memory config.

## Frontend design

- **`useSession.ts`**: extend `User` with `role:'guest'` and a `guest?: GuestPermissions`
  field (from `/api/session/me`). Add `isGuest` computed and `guestCan(flag)`; make `can`
  guest-aware where it maps cleanly, but UI gating for guest-specific actions uses
  `guestCan('addToQueue' | 'playNext' | ...)`. `canControlBot` already enforces the bot
  scope and works for guests via the `bots` field.
- **Login page (`Login.vue`)**: when `guestAllowed`, show a prominent
  "以游客身份进入 / Continue as guest" button calling a new `session.continueAsGuest()`
  → `POST /api/session/guest` → refresh → redirect to `?next` or home.
- **Router (`web/src/router/index.ts`)**: in the global `beforeEach`, block guests from
  `/settings` and `/setup` (redirect to home). Default-off ⇒ when not a guest, behavior
  is unchanged.
- **Navbar (`Navbar.vue`)**: hide the settings cog for guests; add a `游客` role badge
  branch; the bot selector already filters via `canControlBot`, so scoped guests only see
  allowed bots.
- **App shell (`App.vue`)**: hide the mobile `/settings` tab for guests; the mini-player
  transport reduces to the guest's allowed actions.
- **SongCard / Queue / Player**: gate each action button by the matching `guestCan(flag)`
  (e.g. show ▶/下一首/添加 per `playNow`/`playNext`/`addToQueue`; show skip/transport/
  remove/clear/mode per their flags). Buttons a guest lacks are hidden, mirroring how
  `Queue.vue` already gates on `can('player.queue')` / `can('player.control')`.
- **Settings → Guest mode admin section (`Settings.vue`)**: new admin-only panel: a
  master enable switch, the 7 permission checkboxes (with 中文 labels), and a bot scope
  control (an "全部机器人 / all bots" toggle + per-bot checkboxes) reusing the existing
  member permission-editor bot allow-list UI. Saving calls `POST /api/bot/settings` with
  the `guestMode` block.

## Defaults, migration & backward-compat

- `getDefaultConfig().guestMode.enabled = false` ⇒ **no behavior change** on upgrade;
  existing installs see nothing until an admin opts in.
- Migration adds the reserved `__guest__` user row idempotently (guarded like the
  existing `backfillMemberPermissions` `schema_meta` marker) and does **not** grant it
  any `user_permissions` (guest authorization is config-driven, not row-driven).
- `loadConfig` deep-merges `guestMode` so older config files gain the new block with
  defaults.
- Member/admin flows, capabilities, and the backfill are untouched.

## Testing (TDD)

- **Config**: `getDefaultConfig` includes `guestMode` default-off; `loadConfig`
  deep-merges a partial `guestMode` (missing sub-keys back-filled); round-trips through
  `saveConfig`.
- **`resolvePermissionContext` guest branch**: empty member capabilities; `bots` `"all"`
  vs scoped Set; `guest` permissions object passthrough.
- **`authorize` gate**: admin bypass; member has/lacks capability → 200/403 (regression
  parity with `requirePermission`); guest allowed only when the specific flag is true;
  guest with no flag on a route → 403; guest on settings reads → 403.
- **Enforcement (mirror `permissions-enforcement.test.ts`)**: each toggle independently
  opens exactly its route(s) for a guest and nothing else; `/play-song`/`/play-playlist`/
  `/play-album` always 403 for guests; per-bot scope: guest 403 on out-of-scope `:botId`.
- **Session entry**: `POST /api/session/guest` → 403 when disabled, mints guest session
  when enabled; guest session bypasses `MAX_SESSIONS_PER_USER`; disabling guest mode
  invalidates existing guest sessions (401); guest TTL shorter than member TTL.
- **WS scope**: guest receives only in-scope bots' `init`/`stateChange`; reject upgrade
  unchanged for no cookie.
- **Frontend** (where covered): `guestCan` gating; router blocks `/settings` for guests.

## Non-goals (YAGNI)

- No guest accounts/usernames, passwords, favorites, or persistence per guest.
- No per-guest individual identity or rate-limiting beyond the existing IP rate limits
  (a basic abuse guard on `/api/session/guest` is in; richer abuse controls are future).
- No change to the `admin | member` capability semantics; guest is an additive,
  config-driven third principal.
- No chat-command (TeamSpeak `!add`/`!playnext`) changes — guest mode is **WebUI-only**
  (the issue is explicitly about WebUI 鉴权).
- Per-guest bot scoping beyond a single shared guest scope is out of scope (one guest
  scope applies to all guests).

## Key files touched

Backend: `src/data/config.ts` (+test), `src/data/permissions.ts` (+test),
`src/data/users.ts` (role union, reserved guest row), `src/data/database.ts` (migration),
`src/data/sessions.ts` (guest TTL + cap bypass), `src/web/middleware/authorize.ts` (new,
+test), `src/web/middleware/requireNotGuest.ts` (new, small — for the config reads),
`src/web/api/session.ts` (guest endpoint, `/me`, `needs-setup`),
`src/web/api/player.ts` (re-gate + guest play-now), `src/web/api/bot.ts` (settings
read-lock + guestMode write), `src/web/api/music.ts` (quality read-lock),
`src/web/server.ts` + `src/web/websocket.ts` (WS scope), `src/web/auth/validateSession.ts`
(guest disable→401), enforcement tests.

Frontend: `web/src/composables/useSession.ts`, `web/src/views/Login.vue`,
`web/src/router/index.ts`, `web/src/components/Navbar.vue`, `web/src/App.vue`,
`web/src/components/SongCard.vue`, `web/src/components/Queue.vue`,
`web/src/components/Player.vue`, `web/src/views/Settings.vue`,
`web/src/stores/player.ts`.
