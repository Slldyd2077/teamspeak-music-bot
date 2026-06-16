# Dedicated-link bot scoping (+ refresh fix) — design

**Issue:** [#79](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot/issues/79) items 2 and 4
**Date:** 2026-05-30
**Status:** Approved (brainstorm), pending implementation plan

## Problem

- **Item 2:** A dedicated link (`/bot/:id`) is meant to give someone control of *one* bot, but today it just sets the active bot and bounces to `/`; the user can still switch to any other bot from the top-right selector.
- **Item 4 (bug):** After opening a dedicated link, refreshing the page loses the bot — the UI falls back to the first bot.

Root cause (verified): `BotRedirect.vue` does `router.replace('/')` (dropping the id), and `activeBotId` is in-memory-only Pinia state with no persistence, so a reload resets it to `bots[0]`.

## Decision (from brainstorm: Q2 = URL-carried scope)

Carry the scoped bot in the **URL query** (`?bot=<id>`). One mechanism fixes **both** items: the URL is durable across refresh (item 4) and shareable/self-clearing, and the frontend locks the selector to the scoped bot (item 2). No localStorage sticky-lock; plain `/` (no `?bot`) = full control. Backend per-bot authorization (PR #80) remains the real boundary — this is a UX lock.

## Design

### Scope state (store)
Add to the player store:
- `scopedBotId: string | null` — the bot the UI is locked to.
- getter `isScoped` = `scopedBotId !== null`.
- action `setScope(id)` / `clearScope()`.
- `setActiveBotId(id)` becomes a no-op (or ignores) when `isScoped` and `id !== scopedBotId`, so stray switch attempts can't change bots.

### URL as the durable source of truth
- `BotRedirect.vue` (`/bot/:id`): instead of `router.replace('/')`, validate the bot exists, then `router.replace({ path: '/', query: { bot: id } })`. (Keeps the "clean" home URL but with `?bot=`.)
- **Router `beforeEach` guard** (the heart of it):
  - If `to.query.bot` is present → `store.setScope(to.query.bot)` and continue.
  - Else if `store.isScoped` (a scope is active and this navigation dropped the param) → redirect to the same route **with** `query.bot = store.scopedBotId` re-attached (so the lock survives in-app navigation to /search, /library, etc.).
  - Else → no scope; continue.
  This keeps `?bot=` on the URL for every route while scoped, so a refresh on *any* route re-establishes the lock → **fixes item 4**.
- On app load / after `fetchBots()`: apply `scopedBotId`/`?bot` to `activeBotId`; if the scoped bot doesn't exist or isn't in the user's allowed set, **clear the scope gracefully** (fall back to normal multi-bot view) rather than locking onto a dead id.

### Exit
- `clearScope()` sets `scopedBotId = null`; the exit affordance navigates to `/` *after* clearing, so the guard won't re-attach `?bot`. This is the only way to leave scoped mode (self-clearing, intentional).

### Navbar (the lock UI)
- When `isScoped`: the bot selector shows **only** the scoped bot, the dropdown/switching is disabled (no chevron / non-interactive), and other bots' "copy link" affordances are not shown.
- Show a small "专属模式" indicator with an "退出" control → `clearScope()` + navigate to `/`.
- When not scoped: unchanged (full selector over `controllableBots`).

### Active-bot coherence
Because every player action already routes through `activeBotId`, locking `activeBotId === scopedBotId` guarantees all controls affect only the scoped bot. The store's `activeBot` getter `bots[0]` fallback still degrades safely if the scoped id ever fails to match (combined with the graceful-clear above).

## Components / files

- `web/src/stores/player.ts` — `scopedBotId` state, `isScoped`, `setScope`/`clearScope`, guard in `setActiveBotId`, apply scope→active in `fetchBots`/init (graceful clear if missing).
- `web/src/router/index.ts` — `beforeEach` scope sync + `?bot` preservation.
- `web/src/views/BotRedirect.vue` — set scope + `replace({ path: '/', query: { bot: id } })`.
- `web/src/components/Navbar.vue` — locked selector + "专属模式/退出" affordance.
- `web/src/App.vue` — ensure scope is applied to `activeBotId` after `fetchBots` on load (if not already handled by the store/guard).

## Testing

Vue UI isn't unit-tested in this repo, so verification is `vue-tsc` + manual run. The **store scope logic is testable** if a lightweight test harness exists for Pinia stores; otherwise assert the pure pieces:
- `setActiveBotId` ignores a switch to a non-scoped bot while scoped; allows the scoped bot.
- `clearScope` resets state.
- A small helper for "resolve scope from query + bots list → {scopedBotId, activeBotId} or cleared-if-missing" can be extracted and unit-tested.
Manual: open `/bot/<id>` → locked to that bot, selector shows only it; refresh → still locked (item 4 fixed); navigate to Search then refresh → still locked; click 退出 → back to all bots; open `/` directly → full control (no lock).

## Non-goals

- No localStorage persistence (URL is the source of truth). No backend change (per-bot auth already exists in #80). No change to how dedicated links are generated (still `<base>/bot/<id>`); only what happens when one is opened.
