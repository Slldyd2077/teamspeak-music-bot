# TeamSpeak chat-command permission control — design

**Origin:** User request — "给 ts 命令也加上权限控制" (give the TS chat commands permission control too, like the WebUI already has). Completes the unused `adminGroups` scaffold the original authors left behind.
**Date:** 2026-06-25
**Status:** Approved (brainstorm), pending implementation plan

## Scope

Add permission control to **TeamSpeak chat commands** (`!play`, `!add`, `!stop`, …). Today any client in a channel with the bot can run any command; only the WebUI path is permission-gated. This adds a **binary admin gate** keyed on the sender's **TS server groups**: a fixed set of "admin" commands may be restricted to members of configured admin server-groups, while all other commands stay public. Enforcement is **opt-in and backward-compatible** — it activates only once an admin lists their server-group ID(s).

The privileged server-groups are configured in `config.adminGroups` (already declared, currently unused) and become editable from the WebUI.

## Problem

`src/bot/commands.ts` already declares `PUBLIC_COMMANDS` / `ADMIN_COMMANDS` sets and an `isAdminCommand()` helper, and `src/bot/instance.ts:325` has the stub `// TODO: Check if invoker is in adminGroups` — but none of it gates anything. `config.adminGroups: number[]` (`src/data/config.ts:21,46`) is documented as a legacy placeholder and read nowhere. So chat commands are unauthenticated: anyone can `!stop`, `!clear`, `!remove`, move the bot, change volume/mode. The WebUI, by contrast, gates everything via `authorize()` at the HTTP layer.

`executeCommand` (`instance.ts:351`) is **shared** by the chat handler and the WebUI player router; the WebUI gates at the HTTP layer, so the chat gate must live in the **chat handler**, never inside `executeCommand` (else the already-gated WebUI would be double-gated).

## Decisions (from brainstorm)

1. **Binary admin gate**, not per-group capabilities and not a whole-bot allowlist. Reuses the existing `adminGroups` scaffold.
2. **Admin command set (fixed, one source of truth):** `stop`, `clear`, `remove`, `move`, `vol`, `mode`. Everything else is public. The set lives in one constant so reclassifying a command is a one-line change.
3. **Default = open / opt-in (backward-compatible):** when `config.adminGroups` is empty (the default), there is **no enforcement** — admin commands stay open to everyone, exactly as today. Enforcement turns on only when `adminGroups` is non-empty.
4. **Identity key = TS server groups**, matched against `adminGroups`.
5. **Fail-closed on undeterminable groups:** if an admin command arrives, enforcement is on, and the sender's groups cannot be determined (even after a fallback lookup), **deny**.
6. **Reply on deny:** the bot sends the sender a brief permission-denied message (silent denial is confusing; the bot already replies to commands).
7. **Config surface:** `adminGroups` becomes editable from an admin-only WebUI Settings section, live-applied via the existing `/api/bot/settings` endpoint; `config.json` continues to work.

## Permission model

Tier definitions live in `src/bot/commands.ts` (repurpose the existing dead sets; the admin set is the source of truth):
- **Admin commands:** `stop`, `clear`, `remove`, `move`, `vol`, `mode`.
- **Public commands:** all others (`play`, `add`, `playnext`/`pn`, `skip`/`next`, `prev`, `pause`, `resume`, `now`, `queue`/`list`, `lyrics`, `vote`, `help`, `search`/`find`, `playlist`, `album`, `artist`, `fm`).

**Enforcement rule** — a command is **allowed** iff:
1. it is a public command, **OR**
2. `config.adminGroups` is empty (enforcement off), **OR**
3. the sender's server groups ∩ `config.adminGroups` ≠ ∅.

Otherwise it is **denied** (no execution; a denial reply is sent).

Expressed as a pure, unit-testable helper (no TS/async dependency):
```ts
// returns true = allowed, false = denied
function canRunCommand(
  commandName: string,
  invokerGroups: readonly (string | number)[],
  adminGroups: readonly number[]
): boolean
```
- not an admin command → `true`.
- admin command, `adminGroups.length === 0` → `true` (enforcement off).
- admin command, non-empty `adminGroups` → `true` iff any `invokerGroups` value (normalized to number/string consistently) is in `adminGroups`, else `false`.

> Note: `invokerGroups` from TS are strings; `adminGroups` are numbers. Normalize both sides (compare as the same type) to avoid `"6" !== 6` bugs.

## Identity resolution

The TS library already delivers the sender's server groups on each chat event (`TextMessage.invokerGroups: string[]` in `@honeybbq/teamspeak-client`), but the wrapper type `TS3TextMessage` (`src/ts-protocol/client.ts:58-64`) and its mapping (`client.ts:205-214`) **drop** it.

Changes:
1. Add `invokerGroups: string[]` to `TS3TextMessage` and populate it from `msg.invokerGroups` in the mapping.
2. **Availability caveat:** `invokerGroups` is populated only when the sender's client is in the bot's local cache (typically same channel / in view). For a private message from an unseen client, it is `[]`.
3. **Fallback lookup (only when needed):** in the gate, if the command is admin-gated **and** enforcement is on **and** `invokerGroups` is empty, perform a targeted lookup of the sender's groups keyed on `invokerId` (clid) — reuse the already-wrapped `getClientsInChannel()` (`client.ts:314-323`, whose `ClientInfo` carries `serverGroups`), or add a thin wrapper around the library's `getClientInfo(client, clid)` for a precise `clientinfo` query. This query is skipped entirely for public commands, when enforcement is off, and when the event already carried groups (the common "listener in the channel types `!stop`" case).
4. **Fail-closed:** if after the fallback the groups are still unknown, deny the admin command.

## Enforcement seam

In `handleTextMessage` (`src/bot/instance.ts:317`), replace the dead stub at `instance.ts:325-327` with the real check, placed after `parseCommand` succeeds and **before** `executeCommand` (`instance.ts:335`):
- compute `allowed` via `canRunCommand(parsed.name, msg.invokerGroups, this.config.adminGroups)`, performing the async fallback lookup only when the synchronous check is "deny due to empty groups on an admin command with enforcement on";
- if denied → send the denial reply to `msg` (respecting its `targetMode`/sender) and return without executing;
- if allowed → `executeCommand(parsed, msg)` as today.

`executeCommand` stays permission-agnostic, so the WebUI path is unaffected.

**Live config:** `BotInstance` already holds the shared `config` object by reference (passed through `BotInstanceOptions`); `POST /api/bot/settings` mutates that same object in place, so reading `this.config.adminGroups` in the gate reflects edits immediately — no restart, no re-wiring. (Implementation must confirm the instance reads `adminGroups` from the live `config` reference, not a copied-at-construction value.)

## Denied UX

The bot replies to the sender with a short bilingual-ish message, e.g. `⛔ 需要管理员权限（该命令仅限管理员服务器组）`, via the same reply mechanism the command handlers already use, honoring the message's `targetMode` (private vs channel). No execution occurs.

## Config surface

**Backend** (`src/web/api/bot.ts`): extend the existing settings endpoints (already admin-gated: `GET` behind `requireNotGuest`, `POST` behind `requirePermission("bot.manage")`):
- `GET /api/bot/settings` → also return `adminGroups: number[]`.
- `POST /api/bot/settings` → also accept `adminGroups`; validate it is an array of non-negative integers (filter/reject otherwise), assign to `config.adminGroups`, `saveConfig`. Reuses the in-place-mutation + `saveConfig` pattern already used for idle-timeout/auto-pause/guestMode, so it is live-applied.

**Frontend** (`web/src/views/Settings.vue`): a new admin-only section **"命令权限 / Command permissions"** (`v-if="session.isAdmin.value"`), mirroring the idle-timeout/guest-mode sections:
- a text input for comma-separated server-group IDs (parsed to `number[]`, ignoring blanks/non-numbers), a Save button calling `POST /api/bot/settings`, hydrated by the existing `loadIdleTimeout()` GET;
- hint: "仅这些组可运行 stop/clear/remove/move/vol/mode；留空 = 不限制（所有人可用）。如何查看服务器组 ID 见 README。"

**`config.json`**: `adminGroups` continues to work for file-based config.

## Testing

- **`canRunCommand` unit tests** (`src/bot/commands.test.ts` or a new file): public command always allowed; admin command with empty `adminGroups` allowed; admin command with a matching group allowed; admin command with no matching group denied; string-vs-number normalization (`["6"]` matches `[6]`).
- **Handler gate tests:** a denied admin command does NOT call `executeCommand` and triggers a denial reply; an allowed admin command (matching group) and any public command DO call `executeCommand`. (Use a fake `msg` + a `config` with `adminGroups` set; stub the reply + `executeCommand`.)
- **Fallback path:** admin command with empty `invokerGroups` + enforcement on triggers the group lookup; if the lookup yields a matching group → allowed; if it yields nothing → denied (fail-closed).
- **Settings round-trip** (`src/web/api/bot.test.ts`): `POST /api/bot/settings` persists a validated `adminGroups`; `GET` returns it; invalid values (non-array, negative, non-integer) are rejected/filtered.
- **Frontend:** `vue-tsc --noEmit` clean.

## Non-goals (YAGNI)

- No per-group capability map and no whole-bot allowlist (binary admin gate only).
- No per-command customization of the admin/public split in the UI (the set is a code constant; reclassifying is a one-line edit).
- No server-group picker UI (admin types IDs; a picker that lists the bot's visible groups is a possible future enhancement).
- No new chat *management* commands.
- No change to the WebUI authorization model or `executeCommand` semantics.

## Key files touched

Backend: `src/bot/commands.ts` (admin-set constant + `canRunCommand` helper, repurpose the dead sets; +test), `src/bot/instance.ts` (gate in `handleTextMessage`, denial reply, live `adminGroups`), `src/ts-protocol/client.ts` (surface `invokerGroups` on `TS3TextMessage`; possibly a `getClientInfo` wrapper for the fallback), `src/web/api/bot.ts` (settings read/write `adminGroups`; +test). Possibly `src/data/config.ts` (no schema change; `adminGroups` already exists).

Frontend: `web/src/views/Settings.vue` (admin-only 命令权限 section).

Docs: `README.md` (document the feature + how to find TS server-group IDs).
