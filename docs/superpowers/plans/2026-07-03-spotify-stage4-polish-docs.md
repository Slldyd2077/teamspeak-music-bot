# Spotify Source — Stage 4 (Polish, Config UI, Docs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Spotify source's last mile — make it user-configurable and user-authorizable from the web UI, document it (with the required safety warnings), and land the deferred OAuth-robustness hardening.

**Architecture:** The Stage-3 OAuth endpoints (`/api/spotify/{login,callback,status}`) and the single shared `SpotifyOAuth` already exist but are unreachable from the UI. Stage 4 adds: (1) a `spotify` block to the `/api/bot/settings` config API (secret masked); (2) a resolved-backend indicator on `/status`; (3) OAuth refresh/verifier hardening; (4) the approved Settings "Connect Spotify" card (spec §8); (5) the README Spotify section (spec §11/§12). Deferred (documented, NOT built this stage): runtime binary auto-download, connect play-not-reflected diagnostics, extra watchdog.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Express, Vitest (root config also runs `web/src/**/*.test.ts` — stores/composables only; there is NO `.vue` component-test harness), Vue 3 + `<script setup>` + Pinia, `vue-tsc` (web build gate).

## Global Constraints

- **Safe-by-default (spec §2/§7):** Spotify stays inert unless `enabled` AND authorized AND a resolvable binary. Nothing in this stage may change behavior when `spotify.enabled === false`.
- **Never expose secrets (spec §2/§7):** `clientSecret` is the operator's own value. The config GET API MUST NOT return the raw `clientSecret` — return only a boolean `hasClientSecret`. POST overwrites `clientSecret` only when a non-empty string is supplied (blank/omitted = unchanged). No bundled credentials, no shared Developer app.
- **Permissions:** config writes gated by `requirePermission("bot.manage")`; reads by `requireNotGuest`; the OAuth login card is additionally shown only to `can('platform.auth')` / admins — mirror the existing Settings gating.
- **Validation mirrors `src/data/config.ts`:** `backend` ∈ `{"auto","go-librespot","librespot"}`; `bitrate` ∈ `{96,160,320}`; `deviceName` non-empty trimmed string (else keep prior); strings coerced/guarded. Reuse the exact value sets.
- **Language:** README additions are in Chinese (repo is Chinese-only), matching existing heading style (`## 功能特性` etc.).
- **Licensing (spec §9):** go-librespot is GPL-3.0 — the README must include its license note + a source offer; the bot ships NO binary (source-only Rust librespot; Linux-only go-librespot assets).
- **Honesty:** live audio / Connect control / real OAuth round-trip remain NOT verifiable here (need Premium + real binaries + a real account). "Done" = unit-tested (mocked process/HTTP/FS), `tsc --noEmit` clean, `cd web && npm run build` clean, full suite green, reviewed. Never claim audio works.
- **Branch:** all work on `feat/spotify-audio`. Do NOT create per-task branches.
- **Full suite command:** `npx vitest run --no-file-parallelism` (avoids the users.test.ts bcrypt LOAD flake). Typecheck: `npx tsc --noEmit`. Web build: `cd web && npm run build`.

---

### Task 1: `/api/bot/settings` reads & writes the `spotify` block (secret masked)

**Files:**
- Modify: `src/web/api/bot.ts` (GET `/settings` response + POST `/settings` destructure/validate/echo)
- Test: `src/web/api/bot.test.ts`

**Interfaces:**
- Consumes: `config.spotify: SpotifyConfig` (`{ enabled, backend, clientId, clientSecret, deviceName, bitrate }`), `saveConfig(configPath, config)`, `requirePermission("bot.manage")`, `requireNotGuest` — all already imported/used in this file.
- Produces (new response shape on GET+POST, both add a `spotify` key):
  ```ts
  // masked view — NEVER includes clientSecret
  spotify: {
    enabled: boolean;
    backend: "auto" | "go-librespot" | "librespot";
    clientId: string;
    deviceName: string;
    bitrate: number;
    hasClientSecret: boolean;   // whether a non-empty secret is stored
  }
  ```

- [ ] **Step 1.1: Write failing tests.** Add to `src/web/api/bot.test.ts` (mirror the existing settings tests — reuse their app/harness + auth stubs). Cover:
  1. GET `/api/bot/settings` includes a `spotify` object with `enabled/backend/clientId/deviceName/bitrate/hasClientSecret` and does NOT include a `clientSecret` key. With a stored secret, `hasClientSecret === true`; with `clientSecret: ""`, `false`.
  2. POST `/api/bot/settings` with `{ spotify: { enabled: true, backend: "librespot", clientId: "cid", deviceName: "Dev", bitrate: 160 } }` updates all those fields and echoes the masked view; `saveConfig` called.
  3. POST with `{ spotify: { backend: "bogus" } }` leaves `backend` unchanged (invalid rejected, not 400 for the whole request — partial-merge semantics like the other fields). Same for `bitrate: 999`.
  4. POST with `{ spotify: { clientSecret: "newsecret" } }` sets the secret (assert via `hasClientSecret === true` in the echo AND that `config.spotify.clientSecret === "newsecret"`). POST with `{ spotify: { clientSecret: "" } }` does NOT overwrite an existing secret.
  5. POST `/api/bot/settings` spotify write requires `bot.manage` (a member without it → 403; reuse the existing 403 test pattern).
  6. An existing settings POST that omits `spotify` still works and does not touch `config.spotify` (no regression).

- [ ] **Step 1.2: Run the tests — expect failure** (`npx vitest run src/web/api/bot.test.ts`): the `spotify` key is absent from responses.

- [ ] **Step 1.3: Extend GET `/settings`.** Add the masked spotify view to the response object (both the GET at ~line 36 and the POST echo at ~line 103 — extract a local helper to avoid duplication):
  ```ts
  // near the top of createBotRouter, after other helpers:
  const maskedSpotify = () => ({
    enabled: config.spotify.enabled,
    backend: config.spotify.backend,
    clientId: config.spotify.clientId,
    deviceName: config.spotify.deviceName,
    bitrate: config.spotify.bitrate,
    hasClientSecret: config.spotify.clientSecret.length > 0,
  });
  ```
  Add `spotify: maskedSpotify(),` to BOTH the GET response and the POST echo object.

- [ ] **Step 1.4: Handle `spotify` in POST `/settings`.** Add `spotify` to the destructure and a partial-merge block (mirror config.ts validation). Place before `saveConfig(...)`:
  ```ts
  const VALID_BACKENDS = ["auto", "go-librespot", "librespot"] as const;
  const VALID_BITRATES = [96, 160, 320];
  const sp = req.body?.spotify;
  if (sp && typeof sp === "object") {
    const t = config.spotify;
    if (typeof sp.enabled === "boolean") t.enabled = sp.enabled;
    if (typeof sp.backend === "string" && (VALID_BACKENDS as readonly string[]).includes(sp.backend)) {
      t.backend = sp.backend as SpotifyConfig["backend"];
    }
    if (typeof sp.clientId === "string") t.clientId = sp.clientId;
    // Secret is write-only + set-on-non-empty so a blank field never wipes it.
    if (typeof sp.clientSecret === "string" && sp.clientSecret.length > 0) {
      t.clientSecret = sp.clientSecret;
    }
    if (typeof sp.deviceName === "string" && sp.deviceName.trim().length > 0) {
      t.deviceName = sp.deviceName.trim();
    }
    if (typeof sp.bitrate === "number" && VALID_BITRATES.includes(sp.bitrate)) {
      t.bitrate = sp.bitrate;
    }
  }
  ```
  Add the type import if not present: `import type { SpotifyConfig } from "../../data/config.js";`.

- [ ] **Step 1.5: Run tests — expect pass** (`npx vitest run src/web/api/bot.test.ts`). Then `npx tsc --noEmit` clean.

- [ ] **Step 1.6: Commit.**
  ```bash
  git add src/web/api/bot.ts src/web/api/bot.test.ts
  git commit -m "feat(spotify): expose spotify config on /api/bot/settings (secret masked) [S4.1]"
  ```

---

### Task 2: `/api/spotify/status` reports the RESOLVED backend + binary availability (D11)

**Files:**
- Create: `src/music/spotify/backend-select.ts` (pure resolver) + `src/music/spotify/backend-select.test.ts`
- Modify: `src/music/spotify/controller.ts` (delegate `chooseBackend` to the resolver)
- Modify: `src/web/api/spotify.ts` (`/status` shape + `getBackendInfo` type)
- Modify: `src/web/server.ts` (`getBackendInfo` computes the resolved kind)
- Modify: `src/web/api/spotify.test.ts` (update the `/status` shape assertion)

**Interfaces:**
- Produces:
  ```ts
  // backend-select.ts
  export type SpotifyBackendKind = "go-librespot" | "librespot";
  export function resolveSpotifyBackendKind(
    backend: "auto" | "go-librespot" | "librespot",
    goPresent: boolean,
    rustPresent: boolean,
  ): SpotifyBackendKind | null;
  // spotify.ts getBackendInfo now returns:
  { backend: string; deviceName: string; binaryAvailable: boolean }
  // /status response now:
  { authorized: boolean; backend: string; deviceName: string; binaryAvailable: boolean }
  ```
- Note: `SpotifyBackendKind` currently lives in `controller.ts`. Move the canonical definition to `backend-select.ts` and re-export it from `controller.ts` (`export type { SpotifyBackendKind } from "./backend-select.js";`) so existing importers are unaffected.

- [ ] **Step 2.1: Write failing resolver tests** `src/music/spotify/backend-select.test.ts` — the same 8-case matrix S3.5 used, but against the pure function:
  ```ts
  import { describe, it, expect } from "vitest";
  import { resolveSpotifyBackendKind as pick } from "./backend-select.js";
  describe("resolveSpotifyBackendKind", () => {
    it("auto: go present -> go-librespot", () => expect(pick("auto", true, true)).toBe("go-librespot"));
    it("auto: go absent, rust present -> librespot", () => expect(pick("auto", false, true)).toBe("librespot"));
    it("auto: neither -> null", () => expect(pick("auto", false, false)).toBeNull());
    it("go-librespot: present -> go-librespot", () => expect(pick("go-librespot", true, true)).toBe("go-librespot"));
    it("go-librespot: absent -> null even if rust present", () => expect(pick("go-librespot", false, true)).toBeNull());
    it("librespot: present -> librespot", () => expect(pick("librespot", true, true)).toBe("librespot"));
    it("librespot: absent -> null even if go present", () => expect(pick("librespot", true, false)).toBeNull());
    it("auto default fallthrough matches auto", () => expect(pick("auto", true, false)).toBe("go-librespot"));
  });
  ```

- [ ] **Step 2.2: Run — expect failure** (module missing).

- [ ] **Step 2.3: Create the resolver** `src/music/spotify/backend-select.ts`:
  ```ts
  /** Which concrete backend runs for a given config + host binary availability. */
  export type SpotifyBackendKind = "go-librespot" | "librespot";

  /**
   * Pure backend selection shared by SpotifyController.chooseBackend() (per-bot)
   * and the web /status endpoint (process-wide). Booleans in, no IO — the caller
   * supplies platform+binary presence.
   */
  export function resolveSpotifyBackendKind(
    backend: "auto" | "go-librespot" | "librespot",
    goPresent: boolean,
    rustPresent: boolean,
  ): SpotifyBackendKind | null {
    switch (backend) {
      case "go-librespot":
        return goPresent ? "go-librespot" : null;
      case "librespot":
        return rustPresent ? "librespot" : null;
      case "auto":
      default:
        if (goPresent) return "go-librespot";
        if (rustPresent) return "librespot";
        return null;
    }
  }
  ```

- [ ] **Step 2.4: Run resolver tests — expect pass.**

- [ ] **Step 2.5: Delegate from the controller.** In `controller.ts`, import the type+resolver **with a local binding** (a bare `export … from` re-export does NOT create a local name, and `SpotifyBackendKind` is still referenced locally at `chooseBackend()`'s return type and `buildBackend(kind: SpotifyBackendKind)` → would fail TS2304). Use:
  ```ts
  import { resolveSpotifyBackendKind, type SpotifyBackendKind } from "./backend-select.js";
  export type { SpotifyBackendKind };   // keep the name exported for existing importers
  // ...
  chooseBackend(): SpotifyBackendKind | null {
    return resolveSpotifyBackendKind(this.config.backend, this.goPresent(), this.rustPresent());
  }
  ```
  Remove the old inline `switch` body and the standalone `export type SpotifyBackendKind = "go-librespot" | "librespot";` line. Keep `goPresent()/rustPresent()` as-is. Run `npx vitest run src/music/spotify/controller.test.ts` — the S3.5 matrix + auth-gate specs MUST still pass unchanged.

- [ ] **Step 2.6: Update `/status`** in `src/web/api/spotify.ts` — extend the `getBackendInfo` type and the response:
  ```ts
  getBackendInfo: () => { backend: string; deviceName: string; binaryAvailable: boolean };
  // ...
  router.get("/status", requireNotGuest, (_req, res) => {
    const info = opts.getBackendInfo();
    res.json({
      authorized: oauth.isAuthorized(),
      backend: info.backend,
      deviceName: info.deviceName,
      binaryAvailable: info.binaryAvailable,
    });
  });
  ```

- [ ] **Step 2.7: Compute the resolved kind in `server.ts`.** Replace the `getBackendInfo` closure (currently returns raw `config.spotify.backend`) with a resolver call using live probes. Add imports `import { resolveSpotifyBackendKind } from "../music/spotify/backend-select.js";` and `import { isGoLibrespotSupported, findGoLibrespot, isRustLibrespotSupported, findLibrespot } from "../music/spotify/binary.js";` and `import { existsSync } from "node:fs";` (verify existsSync isn't already imported):
  ```ts
  getBackendInfo: () => {
    const goPresent = isGoLibrespotSupported() && existsSync(findGoLibrespot());
    const rustPresent = isRustLibrespotSupported() && existsSync(findLibrespot());
    const resolved = resolveSpotifyBackendKind(options.config.spotify.backend, goPresent, rustPresent);
    return {
      backend: resolved ?? "none",
      deviceName: options.config.spotify.deviceName,
      binaryAvailable: resolved !== null,
    };
  },
  ```

- [ ] **Step 2.8: Update the `/status` test** in `src/web/api/spotify.test.ts` — the existing `toEqual({ authorized, backend, deviceName })` must become `toEqual({ authorized, backend, deviceName, binaryAvailable })`; extend the fake `getBackendInfo` in that test to return `binaryAvailable`. This is THIS task's contract change; update only the status test.

- [ ] **Step 2.9: Verify.** `npx vitest run src/music/spotify/backend-select.test.ts src/music/spotify/controller.test.ts src/web/api/spotify.test.ts` all pass; `npx tsc --noEmit` clean.

- [ ] **Step 2.10: Commit.**
  ```bash
  git add src/music/spotify/backend-select.ts src/music/spotify/backend-select.test.ts src/music/spotify/controller.ts src/web/api/spotify.ts src/web/server.ts src/web/api/spotify.test.ts
  git commit -m "feat(spotify): report resolved backend + binaryAvailable on /status; share backend resolver [S4.2]"
  ```

---

### Task 3: OAuth robustness — in-flight refresh cache + verifier TTL/cap (D9)

**Files:**
- Modify: `src/music/spotify/spotify-oauth.ts`
- Test: `src/music/spotify/spotify-oauth.test.ts`

**Interfaces:**
- Consumes: existing `SpotifyOAuthOptions.deps?: { http?: AxiosInstance }`. Extend deps with an optional clock for testability: `deps?: { http?: AxiosInstance; now?: () => number }`.
- Produces: no public API change. Internals: `refreshInFlight: Promise<string|null> | null`; `pendingVerifiers: Map<string, { verifier: string; expiresAt: number }>`.

- [ ] **Step 3.1: Write failing tests.** Add to `src/music/spotify/spotify-oauth.test.ts`:
  1. **Concurrent refresh collapses to one POST.** Build with a fake `http` whose `post("/api/token")` returns a promise you resolve manually (a `Deferred`) or counts calls, and a MUTABLE fake store (`save()` persists, `load()` returns the last saved value) seeded with an expired token. Fire two `getAccessToken()` calls before the POST resolves; assert `http.post` called exactly ONCE and both awaited results equal the new access token.
  2. **In-flight clears after settle.** Using the same mutable store + a mutable `now` (`let t=…; now=()=>t`), after test 1 resolves, advance `t` past the newly-saved `expiresAt` and call `getAccessToken()` again → a NEW POST fires (count → 2). (Requires `toTokens` on `this.now()` per Step 3.3.)
  3. **Verifier TTL.** With injected mutable `now`, `buildAuthorizeUrl()` at t=0 (capture its `state`), advance `now` to TTL+1, then `handleCallback(code, state)` → returns false (expired) and the entry is gone.
  4. **Verifier cap.** Call `buildAuthorizeUrl()` `VERIFIER_MAX + 1` times (capturing the FIRST `state`); assert **behaviorally** that `handleCallback(code, <first state>)` now returns false (evicted as oldest). Prefer this behavioral assertion over inspecting the private `pendingVerifiers` map (no `as any` cast). Use the injected `now` for all timing.

- [ ] **Step 3.2: Run — expect failure.**

- [ ] **Step 3.3: Add the clock + in-flight refresh.** In the constructor: `this.now = o.deps?.now ?? (() => Date.now());` (add `private now: () => number;`). Rewrite `getAccessToken()` + add the in-flight field:
  ```ts
  private refreshInFlight: Promise<string | null> | null = null;

  async getAccessToken(): Promise<string | null> {
    if (!this.clientId) return null;
    const tokens = this.store.load();
    if (!tokens?.refreshToken) return null;
    if (tokens.accessToken && this.now() < tokens.expiresAt) return tokens.accessToken;
    // Collapse concurrent refreshes: rotation makes a second in-flight refresh
    // use a refresh token the first one already invalidated.
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refresh(tokens).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }
  ```
  Replace the `Date.now()` in `getAccessToken` (spotify-oauth.ts:188) with `this.now()`. **Also change `toTokens` (spotify-oauth.ts:~221) to compute `expiresAt` from `this.now()` instead of `Date.now()`** — this is REQUIRED for testability: if `toTokens` kept real `Date.now()` while `getAccessToken` used an injected fixed clock, a freshly-refreshed token's `expiresAt` would sit far in the injected past/future and the "subsequent call → new POST" test would be non-deterministic. With both on `this.now()`, the test drives a mutable `now` (e.g. `let t = 0; const now = () => t;`) and advances it past the new `expiresAt` to force the second refresh.

- [ ] **Step 3.4: Add verifier TTL + cap.** Change the map type and the two touch points:
  ```ts
  private pendingVerifiers = new Map<string, { verifier: string; expiresAt: number }>();
  private static readonly VERIFIER_TTL_MS = 10 * 60 * 1000;
  private static readonly VERIFIER_MAX = 32;

  private evictStaleVerifiers(): void {
    const t = this.now();
    for (const [state, e] of this.pendingVerifiers) {
      if (e.expiresAt < t) this.pendingVerifiers.delete(state);
    }
    // Bound memory even if all are unexpired: drop oldest (insertion order).
    while (this.pendingVerifiers.size >= SpotifyOAuth.VERIFIER_MAX) {
      const oldest = this.pendingVerifiers.keys().next().value;
      if (oldest === undefined) break;
      this.pendingVerifiers.delete(oldest);
    }
  }
  ```
  In `buildAuthorizeUrl()`: call `this.evictStaleVerifiers();` before the set, then `this.pendingVerifiers.set(state, { verifier, expiresAt: this.now() + SpotifyOAuth.VERIFIER_TTL_MS });`.
  In `handleCallback()`: replace the `get`:
  ```ts
  const entry = this.pendingVerifiers.get(state);
  if (!entry || entry.expiresAt < this.now()) {
    this.pendingVerifiers.delete(state);
    return false;
  }
  const verifier = entry.verifier;
  ```
  (Keep the existing `finally { this.pendingVerifiers.delete(state); }`.)

- [ ] **Step 3.5: Run tests — expect pass.** Then `npx vitest run src/music/spotify/spotify-oauth.test.ts` (all, incl. prior S3.2 tests) + `npx tsc --noEmit` clean.

- [ ] **Step 3.6: Commit.**
  ```bash
  git add src/music/spotify/spotify-oauth.ts src/music/spotify/spotify-oauth.test.ts
  git commit -m "fix(spotify): collapse concurrent OAuth refresh + TTL/cap PKCE verifiers [S4.3]"
  ```

---

### Task 4: Settings "Connect Spotify" card (spec §8)

**Files:**
- Create: `web/src/composables/useSpotifySettings.ts` (pure, testable logic) + `web/src/composables/useSpotifySettings.test.ts`
- Modify: `web/src/views/Settings.vue` (add the card + wiring)

**Interfaces (composable — the unit-tested surface):**
```ts
export interface SpotifyConfigForm {
  enabled: boolean;
  backend: "auto" | "go-librespot" | "librespot";
  clientId: string;
  clientSecret: string;   // blank means "unchanged"
  deviceName: string;
  bitrate: number;
}
export interface SpotifyStatus { authorized: boolean; backend: string; deviceName: string; binaryAvailable: boolean; }
export const SPOTIFY_DISCLAIMER: string;                    // Chinese risk copy
export function buildSpotifyPayload(f: SpotifyConfigForm): { spotify: Record<string, unknown> };  // omits clientSecret when blank
export function parseSpotifyRedirect(search: string): "success" | "error" | null;  // from ?spotify=...
export function statusSummary(s: SpotifyStatus | null, enabled: boolean): { label: string; tone: "ok" | "warn" | "off" };
```

- [ ] **Step 4.1: Write failing composable tests** `web/src/composables/useSpotifySettings.test.ts` (root vitest picks it up; import from `./useSpotifySettings.js` per the repo's ESM `.js` convention):
  - `buildSpotifyPayload` includes `clientSecret` only when non-blank; always includes enabled/backend/clientId/deviceName/bitrate under a `spotify` key.
  - `parseSpotifyRedirect("?spotify=success")==="success"`, `"?spotify=error"==="error"`, `"?x=1"===null`.
  - `statusSummary(null, false)` → tone `"off"`; `statusSummary({authorized:false,binaryAvailable:false,...}, true)` → tone `"warn"`; `statusSummary({authorized:true,binaryAvailable:true,...}, true)` → tone `"ok"`.

- [ ] **Step 4.2: Run — expect failure** (module missing).

- [ ] **Step 4.3: Implement the composable** `web/src/composables/useSpotifySettings.ts`:
  ```ts
  export interface SpotifyConfigForm { enabled: boolean; backend: "auto" | "go-librespot" | "librespot"; clientId: string; clientSecret: string; deviceName: string; bitrate: number; }
  export interface SpotifyStatus { authorized: boolean; backend: string; deviceName: string; binaryAvailable: boolean; }

  // 实验性 · 灰色地带 · 需要 Premium · 使用你自己的开发者应用凭据
  export const SPOTIFY_DISCLAIMER =
    "实验性功能：通过 librespot 播放 Spotify 需要 Spotify Premium 账号，并使用你自己注册的 Spotify 开发者应用凭据。" +
    "该方式处于 Spotify 服务条款的灰色地带，风险自负；默认关闭，不会内置任何共享凭据。";

  export function buildSpotifyPayload(f: SpotifyConfigForm): { spotify: Record<string, unknown> } {
    const spotify: Record<string, unknown> = {
      enabled: f.enabled,
      backend: f.backend,
      clientId: f.clientId,
      deviceName: f.deviceName,
      bitrate: f.bitrate,
    };
    if (f.clientSecret && f.clientSecret.length > 0) spotify.clientSecret = f.clientSecret;
    return { spotify };
  }

  export function parseSpotifyRedirect(search: string): "success" | "error" | null {
    const v = new URLSearchParams(search).get("spotify");
    return v === "success" || v === "error" ? v : null;
  }

  export function statusSummary(s: SpotifyStatus | null, enabled: boolean): { label: string; tone: "ok" | "warn" | "off" } {
    if (!enabled) return { label: "已关闭", tone: "off" };
    if (!s) return { label: "未知", tone: "warn" };
    if (!s.binaryAvailable) return { label: "未检测到 librespot 可执行文件", tone: "warn" };
    if (!s.authorized) return { label: "未授权（点击“连接 Spotify”登录）", tone: "warn" };
    return { label: `已就绪 · 后端 ${s.backend}`, tone: "ok" };
  }
  ```

- [ ] **Step 4.4: Run composable tests — expect pass.**

- [ ] **Step 4.5: Add the card to `Settings.vue`.** Insert a new `.account-card`-style section in the settings surface, gated `v-if="can('platform.auth')"` (mirror the platform-login section). Follow the EXISTING patterns in this file:
  - typed input + Save → mirror the idle-timeout input/saver (`Settings.vue` idle-timeout block + `saveIdleTimeout()` → `POST /api/bot/settings`);
  - select group → mirror the quality button-group for `backend` and `bitrate`;
  - toggle → mirror `localAudioEnabled` for `enabled`.
  **Fields to render (all six):** the `enabled` toggle, `backend` group, `bitrate` group, a `clientId` text input, a `deviceName` text input, and a **Client Secret** field — a write-only password input (`type="password"`, `autocomplete="off"`), left BLANK on load with a "已设置 / 未设置" hint from `hasClientSecret`; a blank secret on Save means "unchanged" (never wipes). The Secret is §8-mandated — do not omit it.
  Wiring (use `axios`, matching the file's other calls):
  - **Load** on mount: `GET /api/bot/settings` → populate the form from `res.data.spotify` (leave `clientSecret` blank; show “已设置/未设置” from `hasClientSecret`); `GET /api/spotify/status` → status indicator via `statusSummary`.
  - **Save**: `POST /api/bot/settings` with `buildSpotifyPayload(form)`; on success re-load status.
  - **Connect**: `const { data } = await axios.get('/api/spotify/login'); window.location.href = data.url;` (guard errors → show message; a 403 means missing `platform.auth`).
  - **Redirect handling**: on mount, `parseSpotifyRedirect(window.location.search)`; if `success`/`error`, show a toast/message and strip the param (e.g. `history.replaceState`). Reuse the file's existing notification/toast mechanism if present; otherwise a simple reactive message line.
  - **Disclaimer**: render `SPOTIFY_DISCLAIMER` prominently in the card.
  Keep the `<script setup>` logic thin — delegate payload/summary/redirect parsing to the composable (already tested). Do not add a `.vue` test (no harness).
  - **Keep the two "spotify auth" concepts distinct:** the card's status comes ONLY from `/api/spotify/status` (playback OAuth `authorized`). Do NOT wire it to the player store's `authStatus.spotify`, which reflects `/api/auth/status?platform=spotify` (metadata Web-API `loggedIn`) — a different thing. Leave the player store untouched.
  - **`vue-tsc` typing:** annotate the form as `reactive<SpotifyConfigForm>({...})` and the status as `ref<SpotifyStatus | null>(null)`; otherwise a button-group assignment (`form.backend = 'librespot'`) widens `backend` to `string` and the `null` init breaks the union passed into `buildSpotifyPayload`/`statusSummary` under `vue-tsc --noEmit`.
  - **Hard order dependency:** `binaryAvailable` on `/api/spotify/status` exists only after Task 2 — execute this task AFTER Task 2.

- [ ] **Step 4.6: Build gate.** `cd web && npm run build` → `vue-tsc --noEmit` clean + vite build succeeds. Then from root `npx vitest run web/src/composables/useSpotifySettings.test.ts` green.

- [ ] **Step 4.7: Commit.**
  ```bash
  git add web/src/composables/useSpotifySettings.ts web/src/composables/useSpotifySettings.test.ts web/src/views/Settings.vue
  git commit -m "feat(spotify): Connect-Spotify settings card (config + OAuth login + status) [S4.4]"
  ```

**Notes:** NOT e2e-verifiable (needs a real account/binary). Verified = composable unit tests + `vue-tsc` typecheck + build. The card only exposes config + a login trigger; it never displays the stored `clientSecret` (GET returns `hasClientSecret`, not the value).

---

### Task 5: README Spotify section (Chinese) — spec §9/§11/§12

**Files:**
- Modify: `README.md` (add a `## Spotify 音源（实验性）` section; add "Spotify" to the feature bullet if appropriate)

**Content (required — write real prose, not placeholders):**
- [ ] **Step 5.1:** Add a top-level section `## Spotify 音源（实验性）` covering, in Chinese:
  1. **醒目警告框:** 实验性；需要 **Spotify Premium**；使用**你自己注册的 Spotify 开发者应用**（不内置任何共享凭据）；处于 Spotify 服务条款灰色地带，风险自负；**默认关闭**。
  2. **工作原理（简述）:** 通过 librespot（Rust）/ go-librespot（Linux）作为独立进程解码 → PCM → ffmpeg 重采样到 48k → 走现有 Opus 发送管线。元数据来自 Spotify Web API。
  3. **平台矩阵:** Windows → `librespot`(Rust)；Linux/Docker → `go-librespot`（可回退 `librespot`）；`auto` 自动选择（表格）。
  4. **获取二进制:** Rust librespot 无预编译包 → `cargo install librespot` 或 scoop/choco，或将可执行文件放入项目 `bin/`（`bin/librespot.exe` / `bin/librespot`）。go-librespot 仅提供 Linux 资产（`github.com/devgianlu/go-librespot/releases`），放入 `bin/go-librespot` 或加入 PATH。
  5. **注册开发者应用 + 回调:** 在 Spotify Developer Dashboard 建应用，取 Client ID，回调地址填 `http://127.0.0.1:<webPort>/api/spotify/callback`（与设置里的 Web 端口一致）；PKCE 不需要 Client Secret。
  6. **启用步骤:** 设置页「连接 Spotify」卡片 → 填 Client ID、选后端、开启开关 → 保存 → 点「连接 Spotify」完成 OAuth 授权。
  7. **许可与来源:** go-librespot 为 **GPL-3.0**，作为独立子进程调用（mere aggregation，不影响本项目许可）；附上其源码地址与许可说明（source offer）。
  8. **故障排查:** 「未检测到 librespot」→ 检查 `bin/` 或 PATH；「未授权」→ 完成 OAuth；Windows 不支持 go-librespot（FIFO 仅限 POSIX）。
- [ ] **Step 5.2:** Sanity-check the doc renders (headings consistent with existing `##` style; links valid). No code test.
- [ ] **Step 5.3: Commit.**
  ```bash
  git add README.md
  git commit -m "docs(spotify): README Spotify source section — setup, binaries, warnings, license [S4.5]"
  ```

---

### Task 6: Rust Connect command retry/backoff (recovery/watchdog — spec §4.3/§13)

**Rationale:** Spec §4.3 mandates "a watchdog + retry/backoff for device-visibility latency and command 202/404 flakiness"; §13 lists Rust Connect as the **top risk** (mitigation: retry/backoff + degrade-to-skipped). Stage 3 already landed the device-visibility watchdog (`waitForDevice()` bounded poll in `rust-librespot.ts`) and per-track device-absence → skip (`findDeviceByName`→null → `playTrack` false → BotInstance skips). The remaining, un-built piece is transient-failure retry/backoff on the Connect **mutating commands** — this task adds it while preserving C3.6 (never reject up the queue path; swallow on exhaustion).

**Files:**
- Modify: `src/music/spotify/connect-api.ts` (retry/backoff around the mutating PUTs; optional injected `sleep`/`logger`)
- Modify: `src/music/spotify/controller.ts` (pass `this.logger` into the default `SpotifyConnectApi`)
- Test: `src/music/spotify/connect-api.test.ts`

**Interfaces:**
- Consumes: existing `constructor(getToken: () => Promise<string|null>, deps?: { http?: AxiosInstance })`. **Extend deps** to `{ http?: AxiosInstance; sleep?: (ms: number) => Promise<void>; logger?: import("pino").Logger }` (all optional → source-compatible).
- No public method signature change: `transfer/play/pause/resume/seek` stay `Promise<void>` and still swallow on final failure.

- [ ] **Step 6.1: Write failing tests** in `src/music/spotify/connect-api.test.ts` (reuse the existing `getToken`/`http` injection pattern; inject a no-op `sleep: async () => {}` so no real timers run):
  1. `play()` retries a transient 404 then succeeds: `http.put` rejects once with `{ response: { status: 404 } }` then resolves → assert `http.put` called TWICE, no throw.
  2. `play()` exhausts on persistent 500: `http.put` always rejects `{ response: { status: 500 } }` → assert exactly `MAX_ATTEMPTS` calls, no throw (swallowed), and `logger.warn` called once (logger provided).
  3. Non-transient (403) is NOT retried: reject `{ response: { status: 403 } }` → exactly ONE call, no throw.
  4. `429` honors a **capped** `Retry-After`: reject once `{ response: { status: 429, headers: { "retry-after": "1" } } }` then resolve → `sleep` called with a bounded delay (≤ the cap) and 2 calls total.
  5. `transfer()` uses the same retry path (one representative non-`play` mutator) — 404-then-success → 2 calls.

- [ ] **Step 6.2: Confirm Red** (`npx vitest run src/music/spotify/connect-api.test.ts`).

- [ ] **Step 6.3: Implement retry/backoff.** Add module constants + a private helper and route each mutating PUT through it:
  ```ts
  const TRANSIENT = new Set([404, 429, 500, 502, 503]);
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 150;
  const MAX_DELAY_MS = 2_000;
  // ...
  private async mutateWithRetry(put: () => Promise<unknown>): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await put();
        return;
      } catch (err: any) {
        const status = err?.response?.status;
        if (!TRANSIENT.has(status) || attempt === MAX_ATTEMPTS) {
          // C3.6: never reject up the queue path — swallow, but surface once.
          this.logger?.warn({ status }, "Spotify Connect command failed (exhausted/non-retryable)");
          return;
        }
        let delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
        if (status === 429) {
          const ra = Number(err?.response?.headers?.["retry-after"]);
          if (Number.isFinite(ra) && ra > 0) delay = Math.min(ra * 1000, MAX_DELAY_MS);
        }
        await this.sleep(delay);
      }
    }
  }
  ```
  In the constructor: `this.sleep = deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));` and `this.logger = deps?.logger;`. Rewrite `transfer/play/pause/resume/seek` so their body becomes: guard `authHeaders()` as today (unauth → `return;`, no retry), then `await this.mutateWithRetry(() => this.http.put(<url>, <body>, { headers, ... }));`. Keep the exact URLs/bodies/params from the current methods.

- [ ] **Step 6.4: Thread the logger from the controller.** In `controller.ts` where the default connect is built:
  ```ts
  this.connect = o.connect ?? new SpotifyConnectApi(() => this.oauth.getAccessToken(), { logger: this.logger });
  ```
  (`Logger` is already imported in controller.ts.) Injected-connect tests are unaffected.

- [ ] **Step 6.5: Update any conflicting existing connect test.** The S3.3 (C3.6) tests assert mutating calls swallow errors. If any asserts a single `http.put` call on a *transient*-status rejection, it now expects `MAX_ATTEMPTS` — update ONLY that count (this task's contract change). Do NOT weaken the swallow/no-throw guarantees or the non-transient single-call behavior.

- [ ] **Step 6.6: Verify.** `npx vitest run src/music/spotify/connect-api.test.ts src/music/spotify/controller.test.ts` all pass; `npx tsc --noEmit` clean.

- [ ] **Step 6.7: Commit.**
  ```bash
  git add src/music/spotify/connect-api.ts src/music/spotify/connect-api.test.ts src/music/spotify/controller.ts
  git commit -m "feat(spotify): retry/backoff on Connect commands (device-latency/flakiness watchdog) [S4.6]"
  ```

**Notes:** Bounded retry adds latency only on the (off-audio-path) control commands and only on transient failure; the injected `sleep` makes tests instant. Not e2e-verifiable (no real account). The `202`-accepted-but-not-effective case from §4.3 is NOT handled here (it needs post-command state verification, which the existing poll-based track-end already tolerates) — noted as a follow-up.

---

### Task 7: Stage 4 verification + whole-branch final review + finish

**Files:** none (verification + review + branch finish).

- [ ] **Step 7.1: Full verification.** `npx vitest run --no-file-parallelism` (all green), `npx tsc --noEmit` (clean), `cd web && npm run build` (clean). Record counts.
- [ ] **Step 7.2: Whole-branch adversarial review.** Review the ENTIRE `feat/spotify-audio` branch (`git merge-base main HEAD`..HEAD) — Stages 2+3+4 — with a fan-out of finders across dimensions (lifecycle/teardown correctness, OAuth/token security + no-secret-leak, backend selection + gating, async races, error handling, test hygiene) and adversarial verification of each finding. Dispatch ONE fix subagent with the consolidated Critical/Important findings; roll up Minors.
- [ ] **Step 7.3: Address findings**, re-verify, then use superpowers:finishing-a-development-branch to complete the branch (tests green → present options → execute choice).

---

## Self-Review (author)

- **Spec coverage:** §8 Settings card → Task 4; §9 binaries/GPL note + §11 README → Task 5; §12 "docs, README" → Task 5; §12/§4.3/§13 "recovery/watchdog" (Connect retry/backoff) → Task 6 (device-visibility watchdog + per-track skip already landed in Stage 3); D9 → Task 3; D11 → Task 2; config editability (prereq for the card) → Task 1.
- **Deferred (documented, NOT built this stage), with rationale:** runtime binary auto-download (spec §9 calls it "optional"; README documents manual install + Docker instead — avoids a tar.gz/checksum/platform-detection downloader on the critical path); the §4.3 `202`-accepted-but-not-effective verification (needs post-command playback-state confirmation the poll-based track-end already tolerates); D10's separate play-not-reflected diagnostic beyond the retry-exhaustion `logger.warn` Task 6 adds. These are listed in the ledger as follow-ups.
- **Placeholder scan:** backend tasks (1–3) carry complete code; frontend/docs (4–5) carry the tested composable in full + explicit wiring contracts + named existing patterns to mirror (Settings.vue has no component-test harness, so exact `.vue` template text is intentionally pattern-referenced, not dictated line-by-line).
- **Type consistency:** `SpotifyBackendKind` canonicalized in `backend-select.ts`, re-exported from `controller.ts`; `getBackendInfo` return type updated in both `spotify.ts` and its `server.ts` supplier and the `/status` test; `buildSpotifyPayload`/`SpotifyStatus` shapes match Task 1's masked view (`hasClientSecret`) and Task 2's `/status` (`binaryAvailable`).
