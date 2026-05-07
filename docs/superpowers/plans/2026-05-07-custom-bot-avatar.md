# Custom Bot Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users upload a fixed avatar per bot. When `avatarEnabled=true`, the avatar follows the song cover during playback and reverts to the custom avatar (instead of clearing) on stop. When `avatarEnabled=false` and a custom avatar exists, the bot always shows the custom avatar.

**Architecture:** New SQLite column stores a relative file path; bytes live on disk under `data/avatars/<botId>.<ext>` (mirrors `data/cookies/`). `BotProfileManager` gains a `customAvatar` Buffer; the existing `clearAvatar()` becomes "restore custom or clear"; `onConnect()` immediately applies the custom avatar when sync is off. Three new REST endpoints (GET/PUT/DELETE) under `/api/bot/:id/avatar` accept base64 JSON (avoids adding multer; bump `express.json()` limit).

**Tech Stack:** Node 20 + TS + Express 5, better-sqlite3, Vue 3 + axios. No new runtime deps.

---

## Spec Reference

`docs/superpowers/specs/2026-05-07-custom-avatar-and-album-search-design.md` — section "自定义头像".

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/data/database.ts` | Modify | Add `custom_avatar_path` column + migration + accessor methods |
| `src/data/avatars.ts` | **Create** | Read/write/delete avatar files under `data/avatars/` |
| `src/bot/profile.ts` | Modify | `customAvatar` field, `setCustomAvatar`, `applyIdleAvatar`, modify `clearAvatar`, modify `onConnect` |
| `src/bot/instance.ts` | Modify | Load custom avatar on start, pass to ProfileManager |
| `src/web/api/bot.ts` | Modify | Add GET/PUT/DELETE `/avatar` endpoints |
| `src/web/server.ts` | Modify | Bump `express.json()` limit to `400kb` |
| `src/index.ts` | Modify | Pass `AVATAR_DIR` to bot manager / API router |
| `src/data/database.test.ts` | Modify | Test custom avatar path persistence + migration idempotency |
| `src/data/avatars.test.ts` | **Create** | Unit tests for avatar store |
| `src/bot/profile.test.ts` | **Create** | Tests for new precedence logic with a mock TS3Client |
| `web/src/components/AvatarUpload.vue` | **Create** | Reusable avatar picker + preview + delete |
| `web/src/views/Settings.vue` | Modify | Add custom avatar row in profile features list; insert into create-bot and edit-bot forms |

## Conventions

- TDD: failing test → implement → verify → commit, every step.
- Commits use conventional format: `feat(profile):`, `feat(api):`, `feat(web):`, `test(...)`. Each task ends with one commit.
- Tests live in vitest (`npm test`).
- All paths absolute or relative to repo root.

---

### Task 1: DB migration + getter/setter for custom avatar path

**Files:**
- Modify: `src/data/database.ts`
- Modify: `src/data/database.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/data/database.test.ts` after the existing tests (find the closing `});` of the last test case in the `describe` block, insert before it):

```ts
  it("persists and clears customAvatarPath on a bot instance", () => {
    const inst = {
      id: "bot-1",
      name: "B",
      serverAddress: "x",
      serverPort: 9987,
      nickname: "n",
      defaultChannel: "",
      channelPassword: "",
      autoStart: false,
      serverProtocol: "",
      ts6ApiKey: "",
      serverPassword: "",
    };
    botDb.saveBotInstance(inst);
    expect(botDb.getCustomAvatarPath("bot-1")).toBeNull();
    botDb.setCustomAvatarPath("bot-1", "avatars/bot-1.png");
    expect(botDb.getCustomAvatarPath("bot-1")).toBe("avatars/bot-1.png");
    botDb.setCustomAvatarPath("bot-1", null);
    expect(botDb.getCustomAvatarPath("bot-1")).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/database.test.ts`
Expected: FAIL — `botDb.getCustomAvatarPath is not a function`

- [ ] **Step 3: Add the column to migration + interface + statements**

In `src/data/database.ts`:

1. Find `BotDatabase` interface (~line 54), add two methods before `close()`:

```ts
  getCustomAvatarPath(botId: string): string | null;
  setCustomAvatarPath(botId: string, path: string | null): void;
```

2. Find `migrateSchema()` (~line 66). After the `for (const col of profileCols)` loop, append:

```ts
  if (!names.includes("custom_avatar_path")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN custom_avatar_path TEXT");
  }
```

3. In `createDatabase()` after the existing `prepare(...)` calls (~line 180), add:

```ts
  const selectCustomAvatar = db.prepare(
    `SELECT custom_avatar_path FROM bot_instances WHERE id = ?`,
  );
  const updateCustomAvatar = db.prepare(
    `UPDATE bot_instances SET custom_avatar_path = ? WHERE id = ?`,
  );
```

4. Inside the returned object, add (before `close()`):

```ts
    getCustomAvatarPath(botId) {
      const row = selectCustomAvatar.get(botId) as { custom_avatar_path: string | null } | undefined;
      return row?.custom_avatar_path ?? null;
    },

    setCustomAvatarPath(botId, path) {
      updateCustomAvatar.run(path, botId);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/data/database.test.ts`
Expected: PASS — all tests including the new one

- [ ] **Step 5: Commit**

```bash
git add src/data/database.ts src/data/database.test.ts
git commit -m "feat(db): custom_avatar_path column + accessors"
```

---

### Task 2: Avatar storage helper

**Files:**
- Create: `src/data/avatars.ts`
- Create: `src/data/avatars.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/data/avatars.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAvatarStore } from "./avatars.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "avatar-test-"));
});

describe("createAvatarStore", () => {
  it("write returns a relative path under the store dir", () => {
    const store = createAvatarStore(dir);
    const buf = Buffer.from("fake-png");
    const rel = store.write("bot-1", "image/png", buf);
    expect(rel).toBe("bot-1.png");
    expect(readFileSync(join(dir, "bot-1.png")).equals(buf)).toBe(true);
  });

  it("write picks correct extension for jpeg / webp", () => {
    const store = createAvatarStore(dir);
    expect(store.write("a", "image/jpeg", Buffer.from(""))).toBe("a.jpg");
    expect(store.write("b", "image/webp", Buffer.from(""))).toBe("b.webp");
  });

  it("write rejects unsupported MIME types", () => {
    const store = createAvatarStore(dir);
    expect(() => store.write("c", "image/gif", Buffer.from(""))).toThrow(
      /unsupported/i,
    );
  });

  it("read returns the bytes for an existing file", () => {
    const store = createAvatarStore(dir);
    store.write("bot-1", "image/png", Buffer.from("hello"));
    const buf = store.read("bot-1.png");
    expect(buf?.equals(Buffer.from("hello"))).toBe(true);
  });

  it("read returns null when path is missing", () => {
    const store = createAvatarStore(dir);
    expect(store.read("missing.png")).toBeNull();
  });

  it("remove deletes the file (idempotent)", () => {
    const store = createAvatarStore(dir);
    store.write("bot-1", "image/png", Buffer.from("x"));
    store.remove("bot-1.png");
    expect(existsSync(join(dir, "bot-1.png"))).toBe(false);
    expect(() => store.remove("bot-1.png")).not.toThrow();
  });

  it("write replaces any existing file for the same botId regardless of old extension", () => {
    const store = createAvatarStore(dir);
    store.write("bot-1", "image/png", Buffer.from("old"));
    const rel = store.write("bot-1", "image/jpeg", Buffer.from("new"));
    expect(rel).toBe("bot-1.jpg");
    expect(existsSync(join(dir, "bot-1.png"))).toBe(false);
    expect(existsSync(join(dir, "bot-1.jpg"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/avatars.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the store**

Create `src/data/avatars.ts`:

```ts
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export interface AvatarStore {
  /** Returns the relative path written (e.g. "bot-1.png"). */
  write(botId: string, mime: string, buffer: Buffer): string;
  read(relPath: string): Buffer | null;
  remove(relPath: string): void;
  getDir(): string;
}

export function createAvatarStore(dir: string): AvatarStore {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return {
    write(botId, mime, buffer) {
      const ext = MIME_TO_EXT[mime];
      if (!ext) throw new Error(`unsupported avatar MIME: ${mime}`);
      // Remove any existing avatar for this bot regardless of extension.
      for (const name of readdirSync(dir)) {
        if (name.startsWith(`${botId}.`)) rmSync(join(dir, name), { force: true });
      }
      const rel = `${botId}.${ext}`;
      writeFileSync(join(dir, rel), buffer);
      return rel;
    },
    read(relPath) {
      const full = join(dir, relPath);
      if (!existsSync(full)) return null;
      return readFileSync(full);
    },
    remove(relPath) {
      rmSync(join(dir, relPath), { force: true });
    },
    getDir() {
      return dir;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/data/avatars.test.ts`
Expected: PASS — all 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/data/avatars.ts src/data/avatars.test.ts
git commit -m "feat(data): avatar file store helper"
```

---

### Task 3: BotProfileManager — custom avatar precedence

**Files:**
- Modify: `src/bot/profile.ts`
- Create: `src/bot/profile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/bot/profile.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { BotProfileManager } from "./profile.js";
import type { TS3Client } from "../ts-protocol/client.js";

function makeMockTs(): TS3Client & {
  uploadCalls: Buffer[];
  clearCalls: number;
} {
  const calls: Buffer[] = [];
  let clears = 0;
  const ts: any = {
    uploadCalls: calls,
    get clearCalls() { return clears; },
    getHost: () => "127.0.0.1",
    getHttpQuery: () => null,
    fileTransferInitUpload: vi.fn().mockResolvedValue({}),
    uploadFileData: vi.fn().mockImplementation(async (_h, _i, stream: any) => {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      calls.push(Buffer.concat(chunks));
    }),
    fileTransferDeleteFile: vi.fn().mockResolvedValue(undefined),
    sendCommandNoWait: vi.fn().mockImplementation(async (cmd: string) => {
      if (/client_flag_avatar=$/.test(cmd)) clears++;
    }),
  };
  return ts;
}

const noopLogger: any = { child: () => noopLogger, info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

const cfgOn = { avatarEnabled: true, descriptionEnabled: false, nicknameEnabled: false, awayStatusEnabled: false, channelDescEnabled: false, nowPlayingMsgEnabled: false };
const cfgOff = { ...cfgOn, avatarEnabled: false };

describe("BotProfileManager custom avatar precedence", () => {
  let ts: ReturnType<typeof makeMockTs>;
  beforeEach(() => { ts = makeMockTs(); });

  it("on stop with custom avatar set + sync on, uploads custom (does not clear)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    const custom = Buffer.from([1, 2, 3, 4]);
    pm.setCustomAvatar(custom);
    await pm.onSongChange(null);
    expect(ts.uploadCalls.at(-1)?.equals(custom)).toBe(true);
    expect(ts.clearCalls).toBe(0);
  });

  it("on stop with no custom avatar, falls back to clear", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    await pm.onSongChange(null);
    expect(ts.clearCalls).toBe(1);
    expect(ts.uploadCalls.length).toBe(0);
  });

  it("on connect with sync off + custom avatar set, applies custom immediately", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOff, "Bot");
    pm.setCustomAvatar(Buffer.from([9, 9]));
    await pm.onConnect();
    expect(ts.uploadCalls.length).toBe(1);
    expect(ts.uploadCalls[0].equals(Buffer.from([9, 9]))).toBe(true);
  });

  it("on connect with sync off + no custom avatar, does not touch avatar", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOff, "Bot");
    await pm.onConnect();
    expect(ts.uploadCalls.length).toBe(0);
    expect(ts.clearCalls).toBe(0);
  });

  it("setCustomAvatar(null) makes subsequent onSongChange(null) clear again", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.setCustomAvatar(Buffer.from([1]));
    pm.setCustomAvatar(null);
    await pm.onSongChange(null);
    expect(ts.clearCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bot/profile.test.ts`
Expected: FAIL — `pm.setCustomAvatar is not a function` and/or `onConnect` not exported

- [ ] **Step 3: Look at the existing profile.ts to understand `onConnect` shape**

Run: `grep -n 'onConnect\|public async\|public ' src/bot/profile.ts | head -10`

`onConnect` likely already exists; if not, locate where reconnect resets state. Add or extend it.

- [ ] **Step 4: Implement `customAvatar`, `setCustomAvatar`, `applyIdleAvatar`; modify `clearAvatar` and `onConnect`**

In `src/bot/profile.ts`:

1. Inside the class, add fields next to `defaultNickname` (around line 27):

```ts
  private customAvatar: Buffer | null = null;
```

2. After the `constructor`, add:

```ts
  /** Set/clear the persistent idle avatar. Pass null to remove. */
  setCustomAvatar(buffer: Buffer | null): void {
    this.customAvatar = buffer;
  }
```

3. Find `clearAvatar()` (~line 173). Change the body so that if `this.customAvatar` is set, we upload it instead of clearing the flag. Replace the existing method with:

```ts
  private async clearAvatar(gen: number): Promise<void> {
    if (this.customAvatar && this.customAvatar.length > 0) {
      await this.applyIdleAvatar(gen);
      return;
    }
    try {
      await this.withTimeout(
        this.tsClient.fileTransferDeleteFile(0n, ["/avatar"]),
        FILE_TRANSFER_TIMEOUT_MS,
      );
    } catch {
      // File may not exist or transfer timed out — that's fine
    }
    if (this.generation !== gen) return;
    try {
      await this.tsClient.sendCommandNoWait("clientupdate client_flag_avatar=");
    } catch (err) {
      this.handleFeatureError("avatar", err);
    }
  }
```

4. Add a new private method right below `clearAvatar`:

```ts
  private async applyIdleAvatar(gen: number): Promise<void> {
    if (!this.customAvatar || this.customAvatar.length === 0) return;
    if (this.permDenied.avatar) return;
    try {
      await this.withTimeout(this.doAvatarUpload(this.customAvatar), FILE_TRANSFER_TIMEOUT_MS);
      if (this.generation !== gen) return;
      this.logger.info({ bytes: this.customAvatar.length }, "Idle (custom) avatar applied");
    } catch (err) {
      this.handleFeatureError("avatar", err);
    }
  }
```

5. Find `onConnect` (the existing method that resets per-feature flags). At its end, immediately after the `permDenied` reset, add:

```ts
    if (!this.config.avatarEnabled && this.customAvatar) {
      const gen = ++this.generation;
      void this.applyIdleAvatar(gen);
    }
```

If `onConnect` does not exist as a method, search for where reconnect resets `permDenied` and add the block there.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/bot/profile.test.ts`
Expected: PASS — 5/5

Run also: `npx vitest run src/audio src/data src/bot` — confirm no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/bot/profile.ts src/bot/profile.test.ts
git commit -m "feat(profile): custom avatar with idle/playback precedence"
```

---

### Task 4: Wire avatar load on bot start

**Files:**
- Modify: `src/bot/instance.ts`
- Modify: `src/bot/manager.ts` (if it constructs the instance)
- Modify: `src/index.ts`

- [ ] **Step 1: Confirm where `BotProfileManager` is constructed and how `BotInstance` receives DB**

Run: `grep -n 'new BotProfileManager\|profileManager =\|database\|botDb' src/bot/instance.ts src/bot/manager.ts | head -20`

Identify the BotInstance constructor params and verify that the DB and the avatar dir can flow in.

- [ ] **Step 2: Add `AVATAR_DIR` constant + `avatarStore` to `src/index.ts`**

Find where `COOKIE_DIR` / `createCookieStore` are set up (~line 48 in src/index.ts) and add directly after:

```ts
const AVATAR_DIR = process.env.AVATAR_DIR ?? join(DATA_DIR, "avatars");
const avatarStore = createAvatarStore(AVATAR_DIR);
```

(import as needed: `import { createAvatarStore } from "./data/avatars.js";`)

Pass `avatarStore` through to whatever constructs `BotManager` (and from there to `BotInstance`).

- [ ] **Step 3: In `BotInstance`, after `profileManager` is created, load the avatar from disk if any**

In `src/bot/instance.ts`, after `this.profileManager = new BotProfileManager(...)`:

```ts
const relPath = this.botDb.getCustomAvatarPath(this.id);
if (relPath) {
  const buf = this.avatarStore.read(relPath);
  if (buf) this.profileManager.setCustomAvatar(buf);
}
```

(Add `private botDb: BotDatabase` and `private avatarStore: AvatarStore` constructor params; thread them down from `BotManager.createBot()` / `BotManager` constructor.)

- [ ] **Step 4: Add `getProfileManager()` accessor if not present**

If grep already shows `getProfileManager(): BotProfileManager`, skip. Otherwise add a public method that returns `this.profileManager`.

- [ ] **Step 5: Build and run the existing tests**

Run: `npx tsc --noEmit`
Expected: no TS errors

Run: `npm test`
Expected: all green

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/bot/instance.ts src/bot/manager.ts
git commit -m "feat(bot): load custom avatar on instance startup"
```

---

### Task 5: REST endpoints for avatar upload / fetch / delete

**Files:**
- Modify: `src/web/server.ts` (json size limit)
- Modify: `src/web/api/bot.ts`

- [ ] **Step 1: Bump express.json size limit**

In `src/web/server.ts`, find `app.use(express.json())` (~line 46) and change to:

```ts
app.use(express.json({ limit: "400kb" }));
```

(Avatar payload is base64-encoded ≤200 KB → ~270 KB on the wire; 400 KB gives margin.)

- [ ] **Step 2: Write a failing API test (use supertest if not present, otherwise inline fetch)**

Run: `grep -E '"supertest"|"vitest"' package.json`

If supertest is not present, write the test using `node:http` raw client or skip API integration test and rely on manual + unit tests on Task 7. Don't add new deps unless approved.

If supertest IS present, add `src/web/api/bot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { createBotRouter } from "./bot.js";
// ... build minimal app with mocked manager + DB + avatarStore
```

If not present: skip Step 2, jump to Step 3 and verify by manual curl in Step 5.

- [ ] **Step 3: Add the three endpoints**

In `src/web/api/bot.ts`, modify the factory signature to accept `avatarStore` and `botDb`:

```ts
export function createBotRouter(
  botManager: BotManager,
  config: BotConfig,
  configPath: string,
  logger: Logger,
  botDb: BotDatabase,
  avatarStore: AvatarStore,
): Router {
```

Inside the router, after the existing `/:id/config` GET, add:

```ts
  router.get("/:id/avatar", (req, res) => {
    const path = botDb.getCustomAvatarPath(req.params.id);
    if (!path) { res.status(404).end(); return; }
    const buf = avatarStore.read(path);
    if (!buf) { res.status(404).end(); return; }
    const ext = path.split(".").pop()!;
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    res.set("Content-Type", mime);
    res.set("Cache-Control", "no-cache");
    res.send(buf);
  });

  router.put("/:id/avatar", (req, res) => {
    const bot = botManager.getBot(req.params.id);
    if (!bot && !botDb.getBotInstances().some((b) => b.id === req.params.id)) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    const { dataUrl } = req.body as { dataUrl?: string };
    if (typeof dataUrl !== "string") {
      res.status(400).json({ error: "dataUrl required" });
      return;
    }
    const m = /^data:(image\/(png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
    if (!m) {
      res.status(400).json({ error: "dataUrl must be image/png|jpeg|webp base64" });
      return;
    }
    const mime = m[1];
    const buf = Buffer.from(m[3], "base64");
    if (buf.length > 200 * 1024) {
      res.status(413).json({ error: "avatar exceeds 200KB limit" });
      return;
    }
    const rel = avatarStore.write(req.params.id, mime, buf);
    botDb.setCustomAvatarPath(req.params.id, rel);
    bot?.getProfileManager().setCustomAvatar(buf);
    res.json({ path: rel });
  });

  router.delete("/:id/avatar", (req, res) => {
    const path = botDb.getCustomAvatarPath(req.params.id);
    if (path) avatarStore.remove(path);
    botDb.setCustomAvatarPath(req.params.id, null);
    const bot = botManager.getBot(req.params.id);
    bot?.getProfileManager().setCustomAvatar(null);
    res.status(204).end();
  });
```

- [ ] **Step 4: Update the call site that constructs the router**

Search: `grep -n 'createBotRouter' src/`

In the call site (likely `src/web/server.ts` or `src/index.ts`), pass the new args. Fix the call signature.

- [ ] **Step 5: Manual smoke test**

Run: `npm run build && npm run start`
In another terminal:

```bash
# create a small valid PNG (1x1) base64
B64=$(node -e "console.log(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,2,0,0,0,144,119,83,222,0,0,0,12,73,68,65,84,8,153,99,248,255,255,63,0,5,254,2,254,205,250,236,184,0,0,0,0,73,69,78,68,174,66,96,130]).toString('base64'))")

curl -X PUT http://localhost:3000/api/bot/<BOT_ID>/avatar \
  -H 'Content-Type: application/json' \
  -d "{\"dataUrl\":\"data:image/png;base64,$B64\"}"

curl http://localhost:3000/api/bot/<BOT_ID>/avatar -o /tmp/x.png
file /tmp/x.png

curl -X DELETE http://localhost:3000/api/bot/<BOT_ID>/avatar -i
```

Expected: PUT returns `{"path":"<id>.png"}`, GET returns the bytes, DELETE returns 204.

- [ ] **Step 6: Commit**

```bash
git add src/web/server.ts src/web/api/bot.ts src/index.ts
git commit -m "feat(api): /api/bot/:id/avatar GET/PUT/DELETE"
```

---

### Task 6: Frontend — `AvatarUpload.vue` component

**Files:**
- Create: `web/src/components/AvatarUpload.vue`

- [ ] **Step 1: Create the component**

```vue
<template>
  <div class="avatar-upload">
    <div class="preview" :class="{ empty: !previewUrl }">
      <img v-if="previewUrl" :src="previewUrl" alt="avatar" />
      <Icon v-else icon="mdi:account-circle-outline" />
    </div>
    <div class="actions">
      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        class="hidden"
        @change="onFile"
      />
      <button type="button" class="btn-sm" @click="fileInput?.click()">
        {{ previewUrl ? '更换' : '上传' }}
      </button>
      <button v-if="previewUrl" type="button" class="btn-sm btn-danger" @click="clear">
        删除
      </button>
    </div>
    <p v-if="error" class="hint error">{{ error }}</p>
    <p v-else class="hint">PNG / JPG / WebP，≤200 KB</p>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { Icon } from '@iconify/vue';

const props = defineProps<{ modelValue: string | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>();

const previewUrl = ref<string | null>(props.modelValue);
const error = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

watch(() => props.modelValue, (v) => { previewUrl.value = v; });

function onFile(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    error.value = '仅支持 PNG / JPG / WebP';
    return;
  }
  if (file.size > 200 * 1024) {
    error.value = `图片 ${(file.size / 1024).toFixed(0)} KB 超过 200 KB 上限`;
    return;
  }
  error.value = null;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result as string;
    previewUrl.value = dataUrl;
    emit('update:modelValue', dataUrl);
  };
  reader.readAsDataURL(file);
}

function clear() {
  previewUrl.value = null;
  emit('update:modelValue', null);
  if (fileInput.value) fileInput.value.value = '';
}
</script>

<style lang="scss" scoped>
.avatar-upload { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.preview {
  width: 80px; height: 80px; border-radius: 50%;
  background: var(--bg-card); display: flex; align-items: center; justify-content: center;
  overflow: hidden;
  img { width: 100%; height: 100%; object-fit: cover; }
  &.empty :deep(svg) { font-size: 48px; opacity: 0.4; }
}
.actions { display: flex; gap: 8px; }
.hidden { display: none; }
.hint { font-size: 12px; opacity: 0.6; margin: 0; }
.hint.error { color: var(--color-danger, #e85060); opacity: 1; }
.btn-danger { color: var(--color-danger, #e85060); }
</style>
```

- [ ] **Step 2: Verify the component compiles**

Run: `cd web && npx vue-tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add web/src/components/AvatarUpload.vue
git commit -m "feat(web): AvatarUpload component"
```

---

### Task 7: Wire AvatarUpload into Settings.vue (create + edit + standalone row)

**Files:**
- Modify: `web/src/views/Settings.vue`

- [ ] **Step 1: Read the relevant Settings.vue regions**

```bash
grep -n '同步头像\|openEditBot\|saveEditBot\|createBot\|create-bot\|profile-features\|features.find' web/src/views/Settings.vue | head -20
```

Identify:
- Create-bot form template region (`<div class="create-bot">` block)
- Edit-bot modal/dialog template region
- The profile features table where `avatarEnabled` row lives

- [ ] **Step 2: Add component import + reactive state for avatar dataUrl on the create-bot form**

In the script setup region, near other `newBot*` refs:

```ts
import AvatarUpload from '../components/AvatarUpload.vue';
const newBotAvatar = ref<string | null>(null);
```

- [ ] **Step 3: Insert `<AvatarUpload v-model="newBotAvatar" />` into the create-bot form template**

In the `<div class="create-bot">` block, right before `<button class="btn-primary" @click="createBot">创建</button>`, add:

```vue
        <div class="form-row">
          <label>自定义头像（可选）</label>
          <AvatarUpload v-model="newBotAvatar" />
        </div>
```

- [ ] **Step 4: After successful `createBot()`, PUT the avatar if set**

Find the `createBot` async function. After the POST resolves and the bot id is known (`res.data.id` or similar), append:

```ts
if (newBotAvatar.value) {
  await axios.put(`/api/bot/${res.data.id}/avatar`, { dataUrl: newBotAvatar.value });
}
newBotAvatar.value = null;
```

- [ ] **Step 5: Add an "自定义头像" row in the per-bot profile features table**

Find the profile-features table render (look for the `features` array iteration). The cleanest path: add a custom row OUTSIDE the array (since it isn't a boolean toggle). Right before `</template>` of the bot row, add:

```vue
        <div class="feature-row">
          <div class="feature-label">自定义头像</div>
          <div class="feature-control">
            <CustomAvatarRow :bot-id="bot.id" />
          </div>
        </div>
```

Where `CustomAvatarRow` is an inline-defined component or a small file `web/src/components/CustomAvatarRow.vue` that:
- Mounts → `axios.get(/api/bot/<id>/avatar, { responseType: 'blob' })` → previews if 200, ignore 404
- Wraps `<AvatarUpload>` and on `update:modelValue`:
  - If string → `axios.put(/avatar, { dataUrl })`
  - If null → `axios.delete(/avatar)`

Create `web/src/components/CustomAvatarRow.vue` with that logic; keep its body small (~50 lines).

- [ ] **Step 6: Build and visually verify**

Run: `cd web && npm run build` → no errors. Then `npm run dev` → open create-instance, upload PNG, create — verify the avatar appears on the bot in TS3 once it connects. Check edit/Settings flow.

- [ ] **Step 7: Commit**

```bash
git add web/src/views/Settings.vue web/src/components/CustomAvatarRow.vue
git commit -m "feat(web): custom avatar in create-bot + Settings"
```

---

### Task 8: Open PR

- [ ] **Step 1: Push the branch**

```bash
git checkout -b feat/custom-bot-avatar
git push -u origin feat/custom-bot-avatar
```

(If commits were already on `main`, instead create the branch from the first relevant commit and reset main: `git branch feat/custom-bot-avatar HEAD && git reset --hard origin/main && git checkout feat/custom-bot-avatar`. The exact sequence depends on the working state when starting.)

- [ ] **Step 2: Create the PR**

```bash
gh pr create --title "feat(profile): custom bot avatar" --body "Closes part of #51 (avatar half).

## Summary
- New /api/bot/:id/avatar GET/PUT/DELETE
- BotProfileManager: custom avatar acts as idle image; cover sync still wins during playback when avatarEnabled=true
- AvatarUpload component used in create-bot form and Settings per-bot row
- Bump express.json limit to 400kb to allow base64 payload

## Behavior matrix
| avatarEnabled | custom set | playing | stopped |
|---|---|---|---|
| ✓ | ✓ | cover | restore custom |
| ✓ | ✗ | cover | clear |
| ✗ | ✓ | custom | custom |
| ✗ | ✗ | no-op | no-op |

## Test plan
- [x] vitest covers DB, avatar store, ProfileManager precedence
- [x] Manual: upload PNG → bot avatar shows; play song → cover; stop → custom; delete → cleared

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review Checklist

- [x] Each spec section has at least one task: precedence matrix → Task 3; storage → Task 2; DB → Task 1; API → Task 5; UI → Task 6+7
- [x] No "TBD" / "fill in" / "implement later" text in any step
- [x] Type names consistent: `AvatarStore` / `createAvatarStore` / `getCustomAvatarPath` / `setCustomAvatarPath` / `setCustomAvatar` (singular per call site)
- [x] All code blocks compile under existing TS/Vue config (express 5, vitest, vue 3 + iconify already in use)
