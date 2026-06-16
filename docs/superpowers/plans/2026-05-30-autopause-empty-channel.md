# Auto-pause on Empty Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Auto-pause playback when the bot's channel empties (no disconnect) and auto-resume when someone returns — only resuming tracks we auto-paused — gated by the existing global `autoPauseOnEmpty` flag.

**Architecture:** A pure decision function decides pause/resume from (player state, autoPaused, flag, userCount). `BotInstance` owns an `autoPaused` flag and a `checkChannelOccupancy()` that the existing 30s idle poll AND new TS enter/leave/move events both call. The toggle is wired into `/api/bot/settings` + the Settings UI.

**Tech:** Node ESM + TS, Vitest, Express, Vue 3.

**Spec:** `docs/superpowers/specs/2026-05-30-autopause-empty-channel-design.md`

---

## Task 1: Pure occupancy-decision function

**Files:** Create `src/bot/auto-pause.ts`, `src/bot/auto-pause.test.ts`.

- [ ] **Step 1 — failing test** `src/bot/auto-pause.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { decideOccupancyAction } from "./auto-pause.js";

describe("decideOccupancyAction", () => {
  // (playerState, autoPaused, enabled, userCount) => "pause" | "resume" | "none"
  it("pauses when empty while playing and enabled", () => {
    expect(decideOccupancyAction("playing", false, true, 0)).toBe("pause");
  });
  it("does not pause when the feature is disabled", () => {
    expect(decideOccupancyAction("playing", false, false, 0)).toBe("none");
  });
  it("does not pause when idle (nothing playing)", () => {
    expect(decideOccupancyAction("idle", false, true, 0)).toBe("none");
  });
  it("does not pause when already paused", () => {
    expect(decideOccupancyAction("paused", false, true, 0)).toBe("none");
  });
  it("resumes when re-populated and we auto-paused", () => {
    expect(decideOccupancyAction("paused", true, true, 2)).toBe("resume");
  });
  it("does NOT resume a user-paused track on re-population", () => {
    expect(decideOccupancyAction("paused", false, true, 2)).toBe("none");
  });
  it("does nothing when re-populated and already playing", () => {
    expect(decideOccupancyAction("playing", false, true, 2)).toBe("none");
  });
  it("resume is independent of the enabled flag (we already auto-paused)", () => {
    expect(decideOccupancyAction("paused", true, false, 1)).toBe("resume");
  });
});
```

- [ ] **Step 2 — run, expect fail:** `npx vitest run src/bot/auto-pause.test.ts` → module missing.

- [ ] **Step 3 — implement** `src/bot/auto-pause.ts`:

```typescript
export type PlayerStateName = "idle" | "playing" | "paused";
export type OccupancyAction = "pause" | "resume" | "none";

/**
 * Decide what auto-pause should do given the channel occupancy.
 * - empty (userCount <= 0): pause iff enabled and currently playing.
 * - re-populated (userCount > 0): resume iff we previously auto-paused and are still paused.
 * `autoPaused` distinguishes our auto-pause from a user pause, so user pauses are never resumed.
 */
export function decideOccupancyAction(
  playerState: PlayerStateName,
  autoPaused: boolean,
  enabled: boolean,
  userCount: number,
): OccupancyAction {
  const empty = userCount <= 0;
  if (empty) {
    if (enabled && playerState === "playing") return "pause";
    return "none";
  }
  if (autoPaused && playerState === "paused") return "resume";
  return "none";
}
```

- [ ] **Step 4 — run, expect pass:** `npx vitest run src/bot/auto-pause.test.ts` → 8 pass.
- [ ] **Step 5 — commit:** `git add src/bot/auto-pause.ts src/bot/auto-pause.test.ts && git commit -m "feat(autopause): pure occupancy-decision function"`

---

## Task 2: Wire decision into BotInstance (autoPaused flag + checkChannelOccupancy)

**Files:** Modify `src/bot/instance.ts`.

Context: `_startIdlePoller` (~lines 190-206) polls every 30s, computes `userCount = (await getClientsInChannel()).length - 1`, and calls `_scheduleIdleCheck()` (empty) / `_cancelIdleTimer()` (occupied). `cmdPause`/`cmdResume` (~484-494), `cmdStop` (~496-505), and the playback start (`cmdPlay`/resolveAndPlay) wrap `player`. There's an unused `channelUserCount` field (~line 68). The instance has `this.config` (BotConfig) and `this.player`.

- [ ] **Step 1 — add state + helper.** Add a private field `private autoPaused = false;`. Create a method that centralizes occupancy handling and is called with a freshly-computed userCount:

```typescript
import { decideOccupancyAction } from "./auto-pause.js";

private handleOccupancy(userCount: number): void {
  // idle-disconnect (unchanged behavior)
  if (userCount <= 0) this._scheduleIdleCheck();
  else this._cancelIdleTimer();

  // auto-pause
  const action = decideOccupancyAction(
    this.player.getState() as "idle" | "playing" | "paused",
    this.autoPaused,
    this.config.autoPauseOnEmpty,
    userCount,
  );
  if (action === "pause") {
    this.player.pause();
    this.autoPaused = true;
    this.emit("stateChange");
  } else if (action === "resume") {
    this.player.resume();
    this.autoPaused = false;
    this.emit("stateChange");
  }
}
```

- [ ] **Step 2 — route the idle poller through it.** In `_startIdlePoller`, replace the inline `userCount`→schedule/cancel logic with: compute `userCount` then `this.handleOccupancy(userCount)`. (Keep the 30s interval + the same getClientsInChannel call + error handling.) Remove the now-redundant inline schedule/cancel branch (it lives in `handleOccupancy`).

- [ ] **Step 3 — clear autoPaused on user actions + lifecycle.** In `cmdPause`, `cmdResume`, `cmdStop`, and the play-start path (`cmdPlay`/wherever playback (re)starts), set `this.autoPaused = false`. In the `disconnected` handler and on (re)connect, set `this.autoPaused = false`. (These ensure a user pause is never auto-resumed and the flag resets across connections.)

- [ ] **Step 4 — `updateAutoPause`.** Add (mirrors `updateIdleTimeout`):

```typescript
updateAutoPause(enabled: boolean): void {
  this.config.autoPauseOnEmpty = enabled;
  // if turning off, leave current playback as-is; if a track was auto-paused, optionally resume:
  if (!enabled && this.autoPaused && this.player.getState() === "paused") {
    this.player.resume();
    this.autoPaused = false;
    this.emit("stateChange");
  }
}
```

- [ ] **Step 5 — verify:** `npx tsc --noEmit` → exit 0. `npx vitest run src/bot src/audio` → pass (existing tests unaffected).
- [ ] **Step 6 — commit:** `git add src/bot/instance.ts && git commit -m "feat(autopause): drive pause/resume from channel occupancy in BotInstance"`

---

## Task 3: Re-emit TS member events for instant reaction

**Files:** Modify `src/ts-protocol/client.ts`, `src/bot/instance.ts`.

Context: `client.ts` forwards `textMessage`/`disconnected`/`connected` and only debug-logs `clientEnter` (~lines 219-224); `clientLeave`/`clientMoved` are not handled. `BotInstance.setupTsEvents()` (~lines 132-156) wires tsClient events.

- [ ] **Step 1 — re-emit in client.ts.** Where `clientEnter` is logged, also `this.emit("clientEnter", info)`. Add subscriptions for `clientLeave` and `clientMoved` that `this.emit(...)` them upward (match the existing forwarding style; just propagate, no payload transformation needed since the instance re-queries).

- [ ] **Step 2 — react in instance.ts.** In `setupTsEvents()`, add handlers: on `clientEnter` / `clientLeave` / `clientMoved`, call a small `async refreshOccupancy()` that does `const clients = await this.getClientsInChannel(); this.handleOccupancy(clients.length - 1);` (guarded with try/catch + only when connected). This gives near-instant pause/resume; the 30s poll remains the fallback.

- [ ] **Step 3 — verify:** `npx tsc --noEmit` → 0. `npx vitest run src/bot` → pass.
- [ ] **Step 4 — commit:** `git add src/ts-protocol/client.ts src/bot/instance.ts && git commit -m "feat(autopause): re-emit client enter/leave/move for instant pause/resume"`

---

## Task 4: API wiring for the toggle

**Files:** Modify `src/web/api/bot.ts`; add/extend a test.

Context: `GET /api/bot/settings` returns `{ idleTimeoutMinutes }`; `POST /api/bot/settings` validates `idleTimeoutMinutes`, sets `config.idleTimeoutMinutes`, `saveConfig`, then loops `botManager.getAllBots()` → `bot.updateIdleTimeout(...)`. This route is `requirePermission("bot.manage")`-gated.

- [ ] **Step 1 — failing API test** (extend the existing bot settings test or add one): `GET /api/bot/settings` returns `autoPauseOnEmpty` (boolean); `POST /api/bot/settings` with `{ autoPauseOnEmpty: false }` persists it (a follow-up GET reflects false) and calls `updateAutoPause` on bots. Model the harness on the existing settings test.

- [ ] **Step 2 — run, expect fail.**

- [ ] **Step 3 — implement.** In `GET /settings`, add `autoPauseOnEmpty: options.config.autoPauseOnEmpty` to the response. In `POST /settings`, if `typeof req.body.autoPauseOnEmpty === "boolean"`, set `config.autoPauseOnEmpty`, include it in the `saveConfig`, and loop bots calling `bot.updateAutoPause(config.autoPauseOnEmpty)`. Keep the existing `idleTimeoutMinutes` handling intact (handle both fields in one save).

- [ ] **Step 4 — verify:** `npx vitest run src/web` → pass; `npx tsc --noEmit` → 0.
- [ ] **Step 5 — commit:** `git add src/web/api/bot.ts <test> && git commit -m "feat(autopause): expose autoPauseOnEmpty via /api/bot/settings"`

---

## Task 5: Frontend toggle in Settings

**Files:** Modify `web/src/views/Settings.vue` (and the settings load/save it uses).

Context: The **行为设置** section (already `v-if="can('bot.manage')"`) holds the idle-timeout control, loaded via `loadIdleTimeout()` (GET /api/bot/settings) and saved via `saveIdleTimeout()` (POST). Read these first.

- [ ] **Step 1 — implement.** Add an `autoPauseOnEmpty` ref. In the settings load, populate it from the GET response. Add a checkbox/toggle in the 行为设置 section labelled e.g. "频道无人时自动暂停" bound to it, and include `autoPauseOnEmpty` in the POST payload of the save function (alongside `idleTimeoutMinutes`, or via its own save — match the existing pattern). Use existing form/toggle CSS classes.
- [ ] **Step 2 — verify:** `cd web && npx vue-tsc --noEmit` → exit 0; read template back for correctness.
- [ ] **Step 3 — commit:** `git add web/src/views/Settings.vue && git commit -m "feat(autopause): autoPauseOnEmpty toggle in Settings"`

---

## Final verification
- [ ] `npx tsc --noEmit` → 0
- [ ] `npx vitest run src/` → all pass
- [ ] `cd web && npx vue-tsc --noEmit` → 0
- [ ] `npm run build` → succeeds
- [ ] Manual: with a bot playing, leave its channel → music auto-pauses (no disconnect); rejoin → resumes. Manually pause, leave, rejoin → stays paused. Toggle off in Settings → no auto-pause.
