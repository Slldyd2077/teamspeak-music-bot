# TeamSpeak chat-command permission control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate a fixed set of "admin" TeamSpeak chat commands (`stop`, `clear`, `remove`, `move`, `vol`, `mode`) behind configured TS server-group IDs, opt-in and backward-compatible, configurable from the WebUI and `config.json`.

**Architecture:** A pure helper `canRunCommand(name, invokerGroups, adminGroups)` decides allow/deny. The chat handler `handleTextMessage` (NOT the WebUI-shared `executeCommand`) consults it before executing, performs a best-effort group lookup when the sender's groups weren't delivered with the event, fails closed, and replies on deny. The privileged groups live in the already-declared `config.adminGroups`, surfaced through the existing `GET/POST /api/bot/settings` endpoints and an admin-only Settings.vue section.

**Tech Stack:** Node 20, TypeScript (ESM), Express 5, Vitest + supertest (backend), Vue 3 + `vue-tsc` (frontend), `@honeybbq/teamspeak-client`.

## Global Constraints

- **ESM import specifiers:** every relative import ends in `.js` even in `.ts` files (e.g. `import { canRunCommand } from "./commands.js"`).
- **Admin command set (exact, single source of truth):** `stop`, `clear`, `remove`, `move`, `vol`, `mode`. Everything else is public. (Note: `follow` is intentionally NOT admin — it becomes public.)
- **Enforcement is opt-in / backward-compatible:** `config.adminGroups === []` (the default) ⇒ no enforcement; admin commands stay open to everyone exactly as today.
- **Fail closed:** an admin command, with enforcement on, whose sender groups cannot be determined (even after fallback) is **denied**.
- **Group-id normalization:** `invokerGroups` are strings, `adminGroups` are numbers — compare as the same type so `"6"` matches `6`.
- **Denial reply text (exact):** `⛔ 需要管理员权限（该命令仅限管理员服务器组）`.
- **`adminGroups` validation:** array of non-negative integers; filter out everything else; ignore a non-array value entirely.
- **Live config:** `BotInstance` shares the same `config` object the router mutates; the gate reads `this.config.adminGroups` live (no restart, no propagation call).
- **Per-task tests:** run `npx vitest run <file>` (targets `.ts` directly). Before any full `npm test`, run `rm -rf dist` first — a stale untracked `dist/` makes vitest double-run compiled `.test.js` copies (known environment quirk). The repo path contains spaces (`/c/Users/saopig1/Music/teamspeak music bot`) — quote it.
- **Frontend type-check:** `cd web && npx vue-tsc --noEmit` (must be clean).
- **TDD + frequent commits:** every task is red→green→commit. Keep project `tsc`/`vitest` green after each task.

---

### Task 1: `canRunCommand` helper + admin-set as single source of truth

**Files:**
- Modify: `src/bot/commands.ts` (lines 8-16 sets; line 59-61 `isAdminCommand`)
- Test: `src/bot/commands.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `export const ADMIN_COMMANDS: Set<string>` = `{stop, clear, remove, move, vol, mode}`
  - `export function isAdminCommand(commandName: string): boolean` (unchanged signature)
  - `export function canRunCommand(commandName: string, invokerGroups: readonly (string | number)[], adminGroups: readonly number[]): boolean` — consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `src/bot/commands.test.ts`:

```ts
import { canRunCommand, isAdminCommand } from "./commands.js";

describe("isAdminCommand classification", () => {
  it("treats stop/clear/remove/move/vol/mode as admin", () => {
    for (const c of ["stop", "clear", "remove", "move", "vol", "mode"]) {
      expect(isAdminCommand(c)).toBe(true);
    }
  });
  it("treats follow and play as NOT admin", () => {
    expect(isAdminCommand("follow")).toBe(false);
    expect(isAdminCommand("play")).toBe(false);
  });
});

describe("canRunCommand", () => {
  it("allows any public command regardless of groups", () => {
    expect(canRunCommand("play", [], [6])).toBe(true);
    expect(canRunCommand("follow", [], [6])).toBe(true);
  });
  it("allows admin command when enforcement is off (empty adminGroups)", () => {
    expect(canRunCommand("stop", [], [])).toBe(true);
  });
  it("allows admin command when an invoker group matches (string vs number)", () => {
    expect(canRunCommand("stop", ["6"], [6])).toBe(true);
    expect(canRunCommand("stop", [6], [6])).toBe(true);
    expect(canRunCommand("vol", ["8", "6"], [6])).toBe(true);
  });
  it("denies admin command when no invoker group matches", () => {
    expect(canRunCommand("stop", ["8"], [6])).toBe(false);
  });
  it("denies admin command when invoker has no groups and enforcement is on", () => {
    expect(canRunCommand("clear", [], [6])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "src/bot/commands.test.ts"`
Expected: FAIL — `canRunCommand` is not exported / not a function.

- [ ] **Step 3: Implement the helper and tighten the admin set**

In `src/bot/commands.ts`, delete the dead `PUBLIC_COMMANDS` export (nothing imports it; the admin set is the sole source of truth), set `ADMIN_COMMANDS` to the exact spec set (drop `follow`), and add `canRunCommand`. The file becomes:

```ts
export interface ParsedCommand {
  name: string;
  args: string;
  rawArgs: string[];
  flags: Set<string>;
}

/**
 * The fixed set of "admin" chat commands. This is the SINGLE source of truth
 * for which commands the permission gate restricts; reclassifying a command is
 * a one-line edit here. Everything not in this set is public.
 */
export const ADMIN_COMMANDS = new Set([
  "stop", "clear", "remove", "move", "vol", "mode",
]);

export function parseCommand(
  message: string,
  prefix: string,
  aliases: Record<string, string> = {},
): ParsedCommand | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith(prefix)) return null;

  const withoutPrefix = trimmed.slice(prefix.length);
  if (!withoutPrefix) return null;

  const parts = withoutPrefix.split(/\s+/);
  let name = parts[0].toLowerCase();

  if (aliases[name]) {
    name = aliases[name];
  }

  const flags = new Set<string>();
  const argParts: string[] = [];

  for (let i = 1; i < parts.length; i++) {
    if (
      parts[i].startsWith("-") &&
      parts[i].length === 2 &&
      /[a-zA-Z]/.test(parts[i][1])
    ) {
      flags.add(parts[i][1].toLowerCase());
    } else {
      argParts.push(parts[i]);
    }
  }

  return {
    name,
    args: argParts.join(" "),
    rawArgs: argParts,
    flags,
  };
}

export function isAdminCommand(commandName: string): boolean {
  return ADMIN_COMMANDS.has(commandName);
}

/**
 * Decide whether a chat command may run, given the invoker's TS server groups
 * and the configured admin groups. Pure + synchronous so it is trivially unit
 * tested and reused by the async gate in BotInstance.
 *
 * Allowed iff: (1) it is a public command, OR (2) enforcement is off
 * (adminGroups empty), OR (3) some invoker group is in adminGroups.
 * invokerGroups (strings from TS) and adminGroups (numbers) are normalized to
 * strings before comparison so "6" matches 6.
 */
export function canRunCommand(
  commandName: string,
  invokerGroups: readonly (string | number)[],
  adminGroups: readonly number[],
): boolean {
  if (!isAdminCommand(commandName)) return true;
  if (adminGroups.length === 0) return true;
  const admin = new Set(adminGroups.map((g) => String(g)));
  return invokerGroups.some((g) => admin.has(String(g)));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run "src/bot/commands.test.ts"`
Expected: PASS (parser tests + the new classification/canRunCommand tests).

- [ ] **Step 5: Verify nothing else imported the deleted symbol**

Run: `grep -rn "PUBLIC_COMMANDS" src/`
Expected: no matches (confirms the deletion is safe).

- [ ] **Step 6: Commit**

```bash
git add "src/bot/commands.ts" "src/bot/commands.test.ts"
git commit -m "feat(commands): add canRunCommand gate helper + admin-set source of truth"
```

---

### Task 2: Surface `invokerGroups` on `TS3TextMessage`

**Files:**
- Modify: `src/ts-protocol/client.ts` (interface lines 58-64; mapping lines 205-214)
- Test: `src/ts-protocol/text-message.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `TS3TextMessage` gains `invokerGroups: string[]`.
  - `export function toTS3TextMessage(msg: TextMessage): TS3TextMessage` — a pure mapper, used by the `textMessage` event handler and unit-testable. Consumed (the field) by Task 3.

- [ ] **Step 1: Write the failing test**

Create `src/ts-protocol/text-message.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toTS3TextMessage } from "./client.js";
import type { TextMessage } from "@honeybbq/teamspeak-client";

function makeMsg(over: Partial<TextMessage> = {}): TextMessage {
  return {
    invokerName: "Alice",
    invokerUID: "uid-abc",
    message: "!stop",
    invokerGroups: ["6", "8"],
    targetMode: 2,
    targetID: 0n,
    invokerID: 5,
    ...over,
  };
}

describe("toTS3TextMessage", () => {
  it("maps core fields and stringifies invokerID", () => {
    const r = toTS3TextMessage(makeMsg());
    expect(r.invokerName).toBe("Alice");
    expect(r.invokerId).toBe("5");
    expect(r.invokerUid).toBe("uid-abc");
    expect(r.message).toBe("!stop");
    expect(r.targetMode).toBe(2);
  });

  it("preserves the sender's server groups", () => {
    expect(toTS3TextMessage(makeMsg({ invokerGroups: ["6"] })).invokerGroups).toEqual(["6"]);
  });

  it("defaults missing invokerGroups to an empty array", () => {
    const partial = {
      invokerName: "Bob",
      invokerUID: "u",
      message: "!stop",
      targetMode: 1,
      targetID: 0n,
      invokerID: 7,
    } as unknown as TextMessage;
    expect(toTS3TextMessage(partial).invokerGroups).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "src/ts-protocol/text-message.test.ts"`
Expected: FAIL — `toTS3TextMessage` is not exported.

- [ ] **Step 3: Add the field and the pure mapper, and use it in the handler**

In `src/ts-protocol/client.ts`, extend the interface (add `invokerGroups`):

```ts
export interface TS3TextMessage {
  invokerName: string;
  invokerId: string;
  invokerUid: string;
  message: string;
  targetMode: number; // 1=private, 2=channel, 3=server
  invokerGroups: string[]; // sender's TS server-group ids; [] when not in view cache
}
```

Add the pure mapper just below the interface (still above the `TS3Client` class):

```ts
/**
 * Map the library's TextMessage to our wrapper. Preserves invokerGroups (the
 * sender's TS server groups), which the library populates only when the sender
 * is in the bot's client-view cache; otherwise it is []. Used by the chat
 * command permission gate.
 */
export function toTS3TextMessage(msg: TextMessage): TS3TextMessage {
  return {
    invokerName: msg.invokerName,
    invokerId: String(msg.invokerID),
    invokerUid: msg.invokerUID,
    message: msg.message,
    targetMode: msg.targetMode,
    invokerGroups: msg.invokerGroups ?? [],
  };
}
```

Replace the inline mapping inside `this.client.on("textMessage", ...)` (currently lines 205-214) with a call to the mapper:

```ts
    this.client.on("textMessage", (msg: TextMessage) => {
      this.emit("textMessage", toTS3TextMessage(msg));
    });
```

(`TextMessage` is already imported at the top of the file.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "src/ts-protocol/text-message.test.ts"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/ts-protocol/client.ts" "src/ts-protocol/text-message.test.ts"
git commit -m "feat(ts-protocol): surface invokerGroups on TS3TextMessage via pure mapper"
```

---

### Task 3: Permission gate in `handleTextMessage` (fallback lookup + fail-closed + denial reply)

**Files:**
- Modify: `src/bot/instance.ts` (imports lines 10-14; add a module constant; `handleTextMessage` lines 317-349; add two private methods)
- Test: `src/bot/instance.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes:
  - `canRunCommand(commandName, invokerGroups, adminGroups)` from `./commands.js` (Task 1).
  - `TS3TextMessage.invokerGroups: string[]` (Task 2).
  - Existing `this.tsClient.getClientsInChannel(): Promise<ClientInfo[]>` where each `ClientInfo` has `id: number` and `serverGroups: string[]` (library already parses these).
  - Existing `this.tsClient.sendTextMessage(message: string, targetMode?: number): Promise<void>`.
- Produces:
  - `export const COMMAND_DENIED_MESSAGE: string` (exported so the test can assert it).
  - Private `isCommandAllowed(commandName, msg)` and `lookupInvokerGroups(invokerId)` (exercised via prototype in the test).

- [ ] **Step 1: Write the failing tests**

Append to `src/bot/instance.test.ts`:

```ts
import { vi } from "vitest";
import { COMMAND_DENIED_MESSAGE } from "./instance.js";
import type { TS3TextMessage } from "../ts-protocol/client.js";

/** Minimal `this` carrying only what handleTextMessage's gate path touches.
 *  The gate methods live on the prototype and are attached here so calls like
 *  `this.isCommandAllowed(...)` resolve against this same object. */
function makeGateCtx(opts: {
  adminGroups?: number[];
  clients?: Array<{ id: number; serverGroups: string[] }>;
}) {
  const ctx: any = {
    config: { commandPrefix: "!", commandAliases: {}, adminGroups: opts.adminGroups ?? [] },
    logger: { info: vi.fn(), error: vi.fn() },
    tsClient: {
      sendTextMessage: vi.fn(async () => {}),
      getClientsInChannel: vi.fn(async () => opts.clients ?? []),
    },
    executeCommand: vi.fn(async () => null),
    isCommandAllowed: (BotInstance.prototype as any).isCommandAllowed,
    lookupInvokerGroups: (BotInstance.prototype as any).lookupInvokerGroups,
  };
  return ctx;
}

function makeMsg(message: string, invokerGroups: string[] = [], invokerId = "5"): TS3TextMessage {
  return { invokerName: "Tester", invokerId, invokerUid: "uid", message, targetMode: 2, invokerGroups };
}

const handleTextMessage = (BotInstance.prototype as any).handleTextMessage as (
  this: unknown,
  msg: TS3TextMessage,
) => Promise<void>;

describe("BotInstance.handleTextMessage — command permission gate", () => {
  it("runs a public command even with enforcement on", async () => {
    const ctx = makeGateCtx({ adminGroups: [6] });
    await handleTextMessage.call(ctx, makeMsg("!play 晴天"));
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
    expect(ctx.tsClient.sendTextMessage).not.toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("runs an admin command when enforcement is off (empty adminGroups)", async () => {
    const ctx = makeGateCtx({ adminGroups: [] });
    await handleTextMessage.call(ctx, makeMsg("!stop"));
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("runs an admin command when the event carried a matching group", async () => {
    const ctx = makeGateCtx({ adminGroups: [6] });
    await handleTextMessage.call(ctx, makeMsg("!stop", ["6"]));
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
    expect(ctx.tsClient.getClientsInChannel).not.toHaveBeenCalled(); // no fallback needed
  });

  it("denies an admin command when known groups do not match (no fallback, with reply)", async () => {
    const ctx = makeGateCtx({ adminGroups: [6] });
    await handleTextMessage.call(ctx, makeMsg("!stop", ["8"]));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.getClientsInChannel).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("falls back to a group lookup when the event carried no groups, and allows on match", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], clients: [{ id: 5, serverGroups: ["6"] }] });
    await handleTextMessage.call(ctx, makeMsg("!stop", [], "5"));
    expect(ctx.tsClient.getClientsInChannel).toHaveBeenCalledTimes(1);
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the fallback finds the client but no matching group", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], clients: [{ id: 5, serverGroups: ["8"] }] });
    await handleTextMessage.call(ctx, makeMsg("!stop", [], "5"));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("fails closed when the fallback cannot find the client at all", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], clients: [] });
    await handleTextMessage.call(ctx, makeMsg("!stop", [], "5"));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "src/bot/instance.test.ts"`
Expected: FAIL — `COMMAND_DENIED_MESSAGE` is not exported; `isCommandAllowed`/`lookupInvokerGroups` are undefined.

- [ ] **Step 3: Implement the gate**

In `src/bot/instance.ts`, change the commands import (lines 10-14) from `isAdminCommand` to `canRunCommand`:

```ts
import {
  parseCommand,
  canRunCommand,
  type ParsedCommand,
} from "./commands.js";
```

Add a module-level constant just after the imports (above `export interface BotInstanceOptions`):

```ts
/** Reply sent when a non-admin invokes an admin-only chat command. */
export const COMMAND_DENIED_MESSAGE = "⛔ 需要管理员权限（该命令仅限管理员服务器组）";
```

Replace `handleTextMessage` (lines 317-349) so the dead stub becomes the real gate:

```ts
  private async handleTextMessage(msg: TS3TextMessage): Promise<void> {
    const parsed = parseCommand(
      msg.message,
      this.config.commandPrefix,
      this.config.commandAliases
    );
    if (!parsed) return;

    if (!(await this.isCommandAllowed(parsed.name, msg))) {
      this.logger.info(
        { command: parsed.name, invoker: msg.invokerName },
        "Command denied: invoker not in adminGroups"
      );
      try {
        await this.tsClient.sendTextMessage(COMMAND_DENIED_MESSAGE);
      } catch (sendErr) {
        this.logger.error({ err: sendErr }, "Failed to send permission-denied message to chat");
      }
      return;
    }

    this.logger.info(
      { command: parsed.name, args: parsed.args, invoker: msg.invokerName },
      "Command received"
    );

    try {
      const response = await this.executeCommand(parsed, msg);
      if (response) {
        await this.tsClient.sendTextMessage(response);
      }
    } catch (err) {
      this.logger.error({ err, command: parsed.name }, "Command execution error");
      try {
        await this.tsClient.sendTextMessage(
          `Error: ${(err as Error).message}`
        );
      } catch (sendErr) {
        this.logger.error({ err: sendErr }, "Failed to send error message to chat");
      }
    }
  }

  /**
   * Decide whether a chat command may run for this sender. Reads adminGroups
   * live from this.config (the router mutates the same object). Only performs
   * the async group lookup when the synchronous decision is "deny because the
   * event carried no groups" — i.e. an admin command, enforcement on, and
   * empty invokerGroups. Fails closed if groups remain undeterminable.
   */
  private async isCommandAllowed(commandName: string, msg: TS3TextMessage): Promise<boolean> {
    const adminGroups = this.config.adminGroups;
    if (canRunCommand(commandName, msg.invokerGroups, adminGroups)) return true;
    // Here: admin command, enforcement on, and the provided groups did not match.
    // If the event actually carried groups, this is a genuine deny — no lookup.
    if (msg.invokerGroups.length > 0) return false;
    // Groups unknown (sender not in the view cache): one targeted lookup, then
    // re-decide. canRunCommand([], …) is false ⇒ fail-closed when still unknown.
    const groups = await this.lookupInvokerGroups(msg.invokerId);
    return canRunCommand(commandName, groups, adminGroups);
  }

  /**
   * Best-effort lookup of a sender's server groups by client id, via the
   * channel client list (whose entries already carry parsed serverGroups).
   * Returns [] when the client can't be found or the query fails (→ deny).
   */
  private async lookupInvokerGroups(invokerId: string): Promise<string[]> {
    const clid = Number(invokerId);
    if (!Number.isFinite(clid) || clid <= 0) return [];
    try {
      const clients = await this.tsClient.getClientsInChannel();
      const match = clients.find((c) => c.id === clid);
      return match?.serverGroups ?? [];
    } catch {
      return [];
    }
  }
```

- [ ] **Step 4: Run the gate tests to verify they pass**

Run: `npx vitest run "src/bot/instance.test.ts"`
Expected: PASS (existing `runExclusive` tests + the 7 new gate tests).

- [ ] **Step 5: Confirm the live-config invariant**

Confirm `BotInstance` reads `adminGroups` from the shared, mutable config — not a copy. The constructor stores `this.config = options.config` (line 91 region) and the router (`src/web/api/bot.ts`) mutates that same object; no propagation call is needed. Quick check:

Run: `grep -n "this.config = options.config\|this.config.adminGroups" "src/bot/instance.ts"`
Expected: shows the assignment and the gate read (proves the gate uses the live reference).

- [ ] **Step 6: Commit**

```bash
git add "src/bot/instance.ts" "src/bot/instance.test.ts"
git commit -m "feat(bot): gate admin chat commands on adminGroups with fallback + deny reply"
```

---

### Task 4: Read/write `adminGroups` in the settings endpoints

**Files:**
- Modify: `src/web/api/bot.ts` (GET `/settings` lines 35-41; POST `/settings` lines 45-97)
- Test: `src/web/api/bot.test.ts` (append `it` cases to the first `describe("bot router /settings", …)` block)

**Interfaces:**
- Consumes: existing `config.adminGroups: number[]` (already declared in `src/data/config.ts`, default `[]`).
- Produces: `GET /api/bot/settings` returns `adminGroups: number[]`; `POST /api/bot/settings` accepts, validates, persists, and echoes `adminGroups`.

- [ ] **Step 1: Write the failing tests**

Append these `it` cases inside the existing first `describe("bot router /settings", …)` block in `src/web/api/bot.test.ts` (it already wires `app`, `config`, and an admin `cookie`):

```ts
  it("GET /settings includes adminGroups reflecting config", async () => {
    config.adminGroups = [6, 8];
    const res = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.adminGroups).toEqual([6, 8]);
  });

  it("POST /settings persists a validated adminGroups and GET returns it", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ adminGroups: [6, 8] });
    expect(res.status).toBe(200);
    expect(res.body.adminGroups).toEqual([6, 8]);
    expect(config.adminGroups).toEqual([6, 8]);
    const followUp = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(followUp.body.adminGroups).toEqual([6, 8]);
  });

  it("POST /settings filters invalid adminGroups entries (negative, non-integer, non-number)", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ adminGroups: [6, -1, 2.5, "x", 8] });
    expect(res.status).toBe(200);
    expect(config.adminGroups).toEqual([6, 8]);
  });

  it("POST /settings ignores a non-array adminGroups (leaves config unchanged)", async () => {
    config.adminGroups = [6];
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ adminGroups: "6" });
    expect(res.status).toBe(200);
    expect(config.adminGroups).toEqual([6]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "src/web/api/bot.test.ts"`
Expected: FAIL — `res.body.adminGroups` is `undefined`; the POST does not persist `adminGroups`.

- [ ] **Step 3: Extend the GET handler**

In `src/web/api/bot.ts`, add `adminGroups` to the GET `/settings` response (the handler at lines 35-41):

```ts
  router.get("/settings", requireNotGuest, (_req, res) => {
    res.json({
      idleTimeoutMinutes: config.idleTimeoutMinutes ?? 0,
      autoPauseOnEmpty: config.autoPauseOnEmpty,
      adminGroups: config.adminGroups ?? [],
      guestMode: config.guestMode,
    });
  });
```

- [ ] **Step 4: Extend the POST handler**

In the POST `/settings` handler: (a) pull `adminGroups` out of `req.body`; (b) validate + assign before `saveConfig`; (c) echo it in the response. Change the destructuring line (46):

```ts
    const { idleTimeoutMinutes, autoPauseOnEmpty, guestMode, adminGroups } = req.body;
```

Add this block just before `saveConfig(configPath, config);` (line 77):

```ts
    if (Array.isArray(adminGroups)) {
      config.adminGroups = adminGroups.filter(
        (g: unknown): g is number =>
          typeof g === "number" && Number.isInteger(g) && g >= 0,
      );
    }
```

Add `adminGroups` to BOTH `res.json({ … })` bodies in this handler (the success response near line 92, and — if present — keep them consistent):

```ts
    res.json({
      idleTimeoutMinutes: config.idleTimeoutMinutes ?? 0,
      autoPauseOnEmpty: config.autoPauseOnEmpty,
      adminGroups: config.adminGroups ?? [],
      guestMode: config.guestMode,
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run "src/web/api/bot.test.ts"`
Expected: PASS (existing settings/guest-mode tests + the 4 new adminGroups tests).

- [ ] **Step 6: Commit**

```bash
git add "src/web/api/bot.ts" "src/web/api/bot.test.ts"
git commit -m "feat(api): read/write adminGroups in bot settings endpoints"
```

---

### Task 5: Admin-only "命令权限" section in Settings.vue

**Files:**
- Modify: `web/src/views/Settings.vue` (template: add a section after the Guest Mode section, before the Bot Profile section ~line 506; script: add state + handlers near the guest-mode block ~line 1093; hydrate in `loadIdleTimeout` ~line 1024)

**Interfaces:**
- Consumes: `GET /api/bot/settings` → `adminGroups: number[]`; `POST /api/bot/settings` with `{ adminGroups: number[] }` (Task 4). Existing `session.isAdmin.value`.
- Produces: UI only.

- [ ] **Step 1: Add the template section**

In `web/src/views/Settings.vue`, insert this `<section>` immediately AFTER the closing `</section>` of the Guest Mode block (the one whose title is `游客模式`, ends ~line 505) and BEFORE the `<!-- Bot Profile … -->` section:

```html
    <!-- Command Permissions (admin only) -->
    <section v-if="session.isAdmin.value" class="settings-section">
      <h2 class="section-title">命令权限</h2>
      <p class="profile-section-hint">
        限制谁能在 TeamSpeak 聊天里运行管理类命令（stop / clear / remove / move / vol / mode）。
        填写允许的服务器组 ID（逗号分隔）。留空 = 不限制，所有人可用。如何查看服务器组 ID 见 README。
      </p>
      <div class="setting-row">
        <div class="prefix-input-wrap">
          <input v-model="adminGroupsText" class="input input-sm" placeholder="如 6, 8" />
          <button class="btn-primary" :disabled="adminGroupsSaving" @click="saveAdminGroups">
            {{ adminGroupsSaving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </section>
```

- [ ] **Step 2: Add the script state + handlers**

In the `<script setup>` block, add this just after the guest-mode block (after `saveGuestMode` closes, ~line 1093):

```ts
// --- Command permissions (admin only) ---
const adminGroupsText = ref('');
const adminGroupsSaving = ref(false);

function applyAdminGroupsFromServer(groups: unknown) {
  if (Array.isArray(groups)) {
    adminGroupsText.value = groups.filter((g) => typeof g === 'number').join(', ');
  }
}

function parseAdminGroups(text: string): number[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

async function saveAdminGroups() {
  adminGroupsSaving.value = true;
  try {
    const res = await axios.post('/api/bot/settings', { adminGroups: parseAdminGroups(adminGroupsText.value) });
    applyAdminGroupsFromServer(res.data?.adminGroups);
  } catch { /* ignore */ } finally {
    adminGroupsSaving.value = false;
  }
}
```

- [ ] **Step 3: Hydrate on load**

In `loadIdleTimeout` (the existing function ~lines 1024-1031), add the hydrate call alongside `applyGuestModeFromServer`:

```ts
async function loadIdleTimeout() {
  try {
    const res = await axios.get('/api/bot/settings');
    idleTimeout.value = res.data.idleTimeoutMinutes ?? 0;
    autoPauseOnEmpty.value = res.data.autoPauseOnEmpty ?? false;
    applyGuestModeFromServer(res.data.guestMode);
    applyAdminGroupsFromServer(res.data.adminGroups);
  } catch { /* ignore */ }
}
```

- [ ] **Step 4: Type-check the frontend**

Run: `cd "web" && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add "web/src/views/Settings.vue"
git commit -m "feat(web): admin-only command-permission (adminGroups) settings section"
```

---

### Task 6: Document the feature in the README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing (docs).
- Produces: user-facing documentation of the feature + how to find TS server-group IDs.

- [ ] **Step 1: Locate the insertion point**

Run: `grep -n "游客模式\|Guest\|权限\|adminGroups" "README.md"`
Expected: shows the guest-mode / permissions area. Insert the new subsection immediately after the guest-mode documentation block (or, if there is a dedicated permissions/features section, at its end).

- [ ] **Step 2: Add the documentation block**

Insert this markdown at the chosen point:

```markdown
### TeamSpeak 命令权限（管理类命令限制）

默认情况下，频道里任何人都能运行所有聊天命令。你可以把一组「管理类」命令限制为只有特定 TeamSpeak 服务器组的成员才能运行：

- 受限命令：`stop`、`clear`、`remove`、`move`、`vol`、`mode`
- 其余命令（点歌、队列、跳过、歌词等）始终对所有人开放
- **默认不限制**：管理服务器组列表为空时，所有命令对所有人开放（向后兼容）

**配置方式**

- 网页端：设置 → 命令权限，填写允许的服务器组 ID（逗号分隔），保存即时生效。
- 或编辑 `config.json` 的 `adminGroups`（数字数组），例如 `"adminGroups": [6, 8]`。

填入任意服务器组 ID 后，限制立即开启：只有属于这些组之一的用户才能运行受限命令，其他人会收到「⛔ 需要管理员权限」的提示。

> 提示（fail-closed）：当受限命令来自一个机器人当前看不到其服务器组的发送者（例如不在机器人所在频道的私聊），机器人会尝试查询其分组；若仍无法确定，则拒绝执行。

**如何查看服务器组 ID**

在 TeamSpeak 客户端中打开「权限 → 服务器组」（Permissions → Server Groups）对话框，选中某个组后，其 ID 会显示在标题栏/状态栏；或在服务器组管理界面中查看每个组对应的数字 ID。把需要授权的组 ID 填入上面的设置即可。
```

- [ ] **Step 3: Sanity-check the docs render**

Run: `grep -n "命令权限\|adminGroups" "README.md"`
Expected: shows the newly added section.

- [ ] **Step 4: Commit**

```bash
git add "README.md"
git commit -m "docs: document TeamSpeak chat-command permission control"
```

---

## Final verification (after all tasks)

- [ ] Remove stale compiled output, then run the full suite:

```bash
rm -rf dist
npm test
```
Expected: all tests pass (the new `canRunCommand`, `toTS3TextMessage`, gate, and `adminGroups` settings tests included).

- [ ] Full build (backend `tsc` + frontend `vue-tsc` + vite):

```bash
npm run build
```
Expected: SUCCESS (no type errors).
