# Dedicated-link Bot Scoping (+ refresh fix) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Opening a dedicated link locks the WebUI to that one bot (selector shows only it, switching disabled, with an explicit exit); the lock is carried in the URL (`?bot=<id>`) so it survives refresh — fixing item 4 too.

**Architecture:** A `scopedBotId` in the Pinia player store is the runtime lock; the URL query `?bot=<id>` is the durable source of truth. A router `beforeEach` syncs scope from the query and re-attaches `?bot` across in-app navigation while scoped. `BotRedirect` seeds it; Navbar renders the lock; graceful clear if the bot doesn't exist.

**Tech:** Vue 3 + Pinia + vue-router, TypeScript. (Frontend isn't unit-tested in this repo → verify via `vue-tsc` + manual; extract one pure helper to unit-test.)

**Spec:** `docs/superpowers/specs/2026-05-30-dedicated-link-scope-design.md`

---

## Task 1: Store scope state + pure resolve helper (with test)

**Files:** Modify `web/src/stores/player.ts`; create `web/src/stores/scope.ts` + `web/src/stores/scope.test.ts`.

READ `web/src/stores/player.ts` first: `activeBotId` state (~line 52), `setActiveBotId` action (~127-133), `fetchBots` (~196-198 default to bots[0]), `activeBot` getter (~73-75), and the localStorage pattern used by `theme` (~175-183) for reference (we are NOT using localStorage, but match code style).

- [ ] **Step 1 — pure helper + failing test.** Create `web/src/stores/scope.ts`:

```typescript
/** Given the desired scoped id (from ?bot) and the known bot ids, decide the
 * effective scope. Returns the id if it exists, else null (graceful clear:
 * a stale/forbidden id never locks the UI). */
export function resolveScopedBot(
  requestedId: string | null | undefined,
  knownBotIds: readonly string[],
): string | null {
  if (!requestedId) return null;
  return knownBotIds.includes(requestedId) ? requestedId : null;
}
```

`web/src/stores/scope.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveScopedBot } from "./scope.js";

describe("resolveScopedBot", () => {
  it("returns null when no id requested", () => {
    expect(resolveScopedBot(null, ["a", "b"])).toBeNull();
    expect(resolveScopedBot(undefined, ["a"])).toBeNull();
    expect(resolveScopedBot("", ["a"])).toBeNull();
  });
  it("returns the id when it exists in the bot list", () => {
    expect(resolveScopedBot("b", ["a", "b"])).toBe("b");
  });
  it("clears (null) when the requested id is not a known bot", () => {
    expect(resolveScopedBot("ghost", ["a", "b"])).toBeNull();
  });
});
```

- [ ] **Step 2 — run, expect fail:** `npx vitest run web/src/stores/scope.test.ts` → module missing.
      (Note: the repo's vitest runs from root; this test lives under web/. If the root vitest config doesn't include web/src, run it via the web workspace: `cd web && npx vitest run src/stores/scope.test.ts`. Use whichever picks it up; confirm it FAILS first.)

- [ ] **Step 3 — implement the helper** (code above).

- [ ] **Step 4 — add scope state to `web/src/stores/player.ts`:**
  - state: `scopedBotId: null as string | null`.
  - getter: `isScoped: (state) => state.scopedBotId !== null`.
  - actions:
    - `setScope(id: string)` → `this.scopedBotId = id;` and also set `this.activeBotId = id` (scoped == active), then ensure that bot's queue is loaded like `setActiveBotId` does.
    - `clearScope()` → `this.scopedBotId = null;`.
    - `applyScopeFromQuery(requestedId: string | null)` → uses `resolveScopedBot(requestedId, this.bots.map(b => b.id))`; if result non-null → `setScope(result)`; if null and a scope was requested → `clearScope()`. (Called after bots are loaded.)
  - Guard `setActiveBotId(id)`: at the top, `if (this.scopedBotId !== null && id !== this.scopedBotId) return;` so switching is blocked while scoped.

- [ ] **Step 5 — run helper test, expect pass:** `cd web && npx vitest run src/stores/scope.test.ts` → 3 pass. `cd web && npx vue-tsc --noEmit` → exit 0.

- [ ] **Step 6 — commit:** `git add web/src/stores/scope.ts web/src/stores/scope.test.ts web/src/stores/player.ts && git commit -m "feat(scope): player store scopedBotId + resolveScopedBot helper"`

---

## Task 2: Router guard — sync scope from `?bot` + preserve across navigation

**Files:** Modify `web/src/router/index.ts`.

READ the file: the existing `beforeEach` (~lines 36-60) handles needsSetup/auth. Add scope handling AFTER auth resolves (so we don't fight the login redirect). Import the player store (use it inside the guard via `usePlayerStore()` — Pinia is active by the time navigation runs).

- [ ] **Step 1 — implement.** In `beforeEach`, after the existing auth/needsSetup logic decides the navigation is allowed to proceed to `to` (i.e., not redirecting to /login or /first-run), add:

```typescript
const store = usePlayerStore();
const qBot = typeof to.query.bot === "string" ? to.query.bot : null;
if (qBot) {
  // entering/with a scope in the URL — store will validate against bots later
  store.scopedBotId = qBot;        // tentative; applyScopeFromQuery (after fetchBots) confirms/clears
  return next();
}
if (store.scopedBotId) {
  // scoped but this navigation dropped ?bot → re-attach so the lock survives in-app nav + refresh
  if (to.query.bot !== store.scopedBotId) {
    return next({ ...to, query: { ...to.query, bot: store.scopedBotId } });
  }
}
return next();
```

(Adapt to the file's existing `next()` style — it may use `next(...)`/return. Ensure this runs only for allowed navigations, not when redirecting to /login. The exit action in Task 4 calls `store.clearScope()` BEFORE navigating to `/`, so `store.scopedBotId` is null and the re-attach branch is skipped — that's how exit works.)

- [ ] **Step 2 — verify:** `cd web && npx vue-tsc --noEmit` → exit 0. Re-read the guard to ensure no redirect loop (when `to.query.bot === store.scopedBotId`, it does NOT redirect again).

- [ ] **Step 3 — commit:** `git add web/src/router/index.ts && git commit -m "feat(scope): router guard syncs + preserves ?bot across navigation"`

---

## Task 3: BotRedirect seeds the URL scope

**Files:** Modify `web/src/views/BotRedirect.vue`.

READ it: onMounted reads `route.params.id`, ensures `store.fetchBots()`, finds the bot; if found `store.setActiveBotId(id)` + `router.replace('/')`; else shows not-found.

- [ ] **Step 1 — implement.** Change the found-branch to seed scope via the URL instead of bouncing to a bare `/`:
  - keep the fetchBots + existence check,
  - if found: `router.replace({ path: '/', query: { bot: botId } })` (the router guard + store will set the scope). Optionally also call `store.setScope(botId)` directly for immediacy.
  - if not found: unchanged (show "机器人不存在或未加载").

- [ ] **Step 2 — verify:** `cd web && npx vue-tsc --noEmit` → exit 0.
- [ ] **Step 3 — commit:** `git add web/src/views/BotRedirect.vue && git commit -m "feat(scope): dedicated link seeds ?bot scope instead of bare redirect"`

---

## Task 4: Navbar lock UI + apply-scope-on-load

**Files:** Modify `web/src/components/Navbar.vue`, `web/src/App.vue`.

READ both: Navbar has `controllableBots` (computed) + the dropdown selector + `selectBot`; App.vue onMounted calls `playerStore.fetchBots()` (+ loadTheme/connect).

- [ ] **Step 1 — Navbar lock.** When `store.isScoped`:
  - render only the scoped bot (a `displayedBots` computed → if scoped, `controllableBots.filter(b => b.id === store.scopedBotId)`, else `controllableBots`),
  - disable the dropdown open / switching (no chevron, or make the trigger non-interactive) so the user can't switch,
  - hide other bots' "copy link" affordances (only the scoped bot remains anyway),
  - show a small "专属模式" badge and an "退出" button → `store.clearScope(); router.push('/')` (clear BEFORE navigating so the guard doesn't re-attach `?bot`). Import `useRouter` if not present.
  When not scoped: behavior unchanged.

- [ ] **Step 2 — apply scope on load (App.vue).** After `fetchBots()` resolves in onMounted, call `playerStore.applyScopeFromQuery(routeBot)` where `routeBot` is the current `?bot` query (via `useRoute().query.bot` as string|null). This confirms a refreshed `?bot` against the loaded bots and sets activeBotId (or gracefully clears if the bot is gone). (If Task 2's guard already set `scopedBotId` tentatively, this validates it against the now-loaded bot list.)

- [ ] **Step 3 — verify:** `cd web && npx vue-tsc --noEmit` → exit 0. Read templates back for valid syntax; confirm read-only displays aren't broken and the non-scoped path is unchanged.
- [ ] **Step 4 — commit:** `git add web/src/components/Navbar.vue web/src/App.vue && git commit -m "feat(scope): lock Navbar selector to scoped bot + apply scope on load"`

---

## Final verification
- [ ] `cd web && npx vue-tsc --noEmit` → exit 0
- [ ] `npx tsc --noEmit` → exit 0 (backend unaffected)
- [ ] `cd web && npx vitest run src/stores/scope.test.ts` (or root vitest if it includes web) → pass
- [ ] `npm run build` → succeeds
- [ ] Manual: open `/bot/<id>` → URL becomes `/?bot=<id>`, selector shows only that bot, switching disabled; **refresh → still locked** (item 4 fixed); navigate to Search → URL keeps `?bot`; refresh on Search → still locked; click 退出 → back to all bots (`/`, no `?bot`); open `/` directly → full multi-bot control; open `/?bot=<nonexistent>` → gracefully shows all bots (no lock).

## Notes
- Backend per-bot authorization (PR #80) is the real security boundary; this is a UX lock.
- No localStorage — URL is the source of truth, so the lock is shareable and self-clearing.
- Item 4 is fixed as a consequence of carrying `?bot` in the URL across refresh/navigation.
