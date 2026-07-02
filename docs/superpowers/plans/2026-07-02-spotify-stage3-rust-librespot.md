# Spotify Source — Stage 3 (Rust librespot Backend, native Windows/cross-platform) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Real Spotify playback on native Windows (and any platform) via a Rust librespot sidecar whose stdout PCM feeds the existing external-PCM player path, controlled as a Spotify Connect controller through the Web API — behind the SAME `SpotifyAudioBackend` seam Stage 2 defined, so `SpotifyController`/`instance.ts` are largely unchanged.

**Architecture:** `RustLibrespotBackend` spawns `librespot --backend pipe` (stdout PCM, cross-platform) → ffmpeg 44.1k→48k → the Stage-2 `playPcmStream` path. Since Rust librespot is a passive Connect receiver with no play-by-URI CLI, the bot drives playback via the Spotify Web API Connect endpoints (find device → transfer → play URI → pause/seek), authorized by a user OAuth (Authorization Code + PKCE) token that also bootstraps librespot via `--access-token`. Track-end is detected by polling `GET /v1/me/player`. `SpotifyController.chooseBackend()` selects go-librespot on Linux and Rust librespot elsewhere (or per `config.spotify.backend`).

**Tech Stack:** TypeScript (ESM, `.js`), Node 25, `axios` (already a dep), `node:crypto` (PKCE), `vitest`. External binary: Rust librespot (any platform; no prebuilt — user installs).

## Global Constraints

- ESM: all relative imports use the `.js` extension.
- **Reuses the Stage-2 `SpotifyAudioBackend` interface verbatim** — do NOT change it. `RustLibrespotBackend` is a second implementation behind the same seam; `SpotifyController`/`instance.ts` orchestration is unchanged except `chooseBackend()`.
- **Gated & additive:** the Rust backend activates only when `config.spotify.enabled` && a `librespot` binary is resolvable && OAuth is authorized. Otherwise `ensureStarted()` returns false → the Stage-1 sentinel fallback message (queue keeps moving). Do NOT break the Stage-2 go-librespot path or ANY existing test.
- **Backend selection:** `config.spotify.backend` ("auto"|"go-librespot"|"librespot"); `auto` → go-librespot on Linux (if its binary is present), else Rust librespot (if present), else none.
- **Not e2e-testable here:** real audio needs Spotify Premium + a real librespot + a real account. "Done" = code complete, unit-tested with INJECTED/mocked `child_process`/HTTP (no real binary/network), `tsc --noEmit` clean, full `vitest run` green. Never claim audio "works".
- **OAuth (PKCE):** default client = librespot's public client `65b708073fc0480ea92a077233ca87bd` (redirect `http://127.0.0.1:5588/login`); if the user set `config.spotify.clientId`, use their own Developer app with a loopback `http://127.0.0.1:<port>/callback` redirect. Access token ~1h; refresh token ROTATES (persist the newest) and expires ~6 months from original auth (re-auth on `invalid_grant`). Never store a client secret for PKCE. Token store persists under the data dir. ⚠️ Reusing librespot's first-party client is ToS-gray — this is already an experimental, opt-in, Premium-only feature.
- **Connect control endpoints (exact):** `GET /v1/me/player/devices`; `PUT /v1/me/player {device_ids,[play]}`; `PUT /v1/me/player/play?device_id= {uris:[uri]}`; `PUT /v1/me/player/pause`; `PUT /v1/me/player/play` (resume); `PUT /v1/me/player/seek?position_ms=`; `GET /v1/me/player` (204 = no active device). Scopes: `user-modify-playback-state`, `user-read-playback-state`.
- Resolve ffmpeg via `getFfmpegCommand()` (exported from `src/audio/player.js` in Stage 2), never a literal `"ffmpeg"`.
- No new npm dependencies. Run tests: `npx vitest run <path>`; typecheck `npx tsc --noEmit`; full suite `npx vitest run --no-file-parallelism` (avoids pre-existing users.test.ts bcrypt LOAD-timeouts). Research facts: `.superpowers/sdd/stage3-research-map.md`.

## REQUIRED CORRECTIONS (post-review — OVERRIDE the task sections below where they conflict)

**C3.1 (blocker) — ONE shared `SpotifyOAuth` + `SpotifyConnectApi`, threaded to BOTH the web layer AND every controller.** The drafts wrongly build TWO separate OAuth stores (a per-bot one in the controller and a process-wide one in the web server), so a browser login never reaches the backend. Fix:
- In `src/index.ts` build a single instance of each (after config load):
  ```ts
  const spotifyRedirectUri =
    (config.publicUrl.trim().replace(/\/+$/, "") || `http://127.0.0.1:${config.webPort}`) + "/api/spotify/callback";
  const spotifyTokenStore = createSpotifyTokenStore(SPOTIFY_DATA_DIR); // createSpotifyTokenStore takes a DIRECTORY and writes <dir>/oauth-tokens.json — pass the dir, not the filename
  const spotifyOAuth = new SpotifyOAuth({ clientId: config.spotify.clientId || undefined, redirectUri: spotifyRedirectUri, store: spotifyTokenStore });
  const spotifyConnect = new SpotifyConnectApi(() => spotifyOAuth.getAccessToken());
  ```
- Thread the SAME `spotifyOAuth` + `spotifyConnect` into `new BotManager(...)` (add trailing optional params, mirroring `SPOTIFY_DATA_DIR`) AND into `createWebServer({ ..., spotifyOAuth })`.
- `BotManager`: accept `spotifyOAuth?`/`spotifyConnect?`, pass them into ALL THREE `new BotInstance({...})` sites.
- `BotInstance` (`instance.ts:79-88,167-176`): add `spotifyOAuth?`/`spotifyConnect?` to its options and forward into the controller: `new SpotifyController({ ...o, oauth: options.spotifyOAuth, connect: options.spotifyConnect })`.
- `SpotifyController` (Task 5): add `oauth?: SpotifyOAuth` and `connect?: SpotifyConnectApi` to `SpotifyControllerOptions`; store and use them; `chooseBackend()` passes them to `RustLibrespotBackend`. The controller MUST NOT construct its own OAuth/store. If `oauth`/`connect` are absent, the Rust backend is simply unavailable.

**C3.2 (major) — auth model = the user's OWN Spotify Developer app + the web `/callback` redirect; DROP the librespot-public-client default and the orphaned `:5588` listener.** Reusing librespot's first-party client forces the fixed `127.0.0.1:5588/login` redirect, which no task handles (the code is dropped). Instead:
- The OAuth control flow REQUIRES `config.spotify.clientId` (the user's own Developer app — they already need it for Stage-1 metadata). `redirect_uri` = the web callback computed above (`…/api/spotify/callback`). Requested scopes = `SPOTIFY_CONTROL_SCOPES` (includes `streaming`, so the SAME token also bootstraps librespot via `--access-token`).
- `SpotifyOAuth`: if `clientId` is empty, `isAuthorized()` is false and `buildAuthorizeUrl()` throws a clear "set Spotify Client ID first" error. Remove the `LIBRESPOT_PUBLIC_CLIENT_ID`/`LIBRESPOT_REDIRECT_URI` default path and any `:5588` listener from all tasks (Task 6 does NOT stand one up).
- `SpotifyController.ensureStarted()` Rust branch requires `config.spotify.clientId` set AND `oauth.isAuthorized()`; else returns false → the Stage-1 fallback message (hint: "set Spotify Client ID and log in from Settings").
- README/docs (Stage 4) must tell the user to register `http://127.0.0.1:<webPort>/api/spotify/callback` (and their `publicUrl` variant) as a Redirect URI in their Spotify app.

**C3.3 (minor) — `/api/spotify/status` reports the RESOLVED backend, not the raw selector.** Task 5 MUST add and export a pure `export function chooseBackendKind(config: SpotifyConfig): "go-librespot" | "librespot" | "none"` in `controller.ts` (same logic as the instance `chooseBackend()`: `config.spotify.backend` override, else `auto` → `isGoLibrespotSupported() && existsSync(findGoLibrespot())` ? "go-librespot" : `isRustLibrespotSupported() && existsSync(findLibrespot())` ? "librespot" : "none"). The web `status` route (Task 6) imports and calls it, instead of returning `config.spotify.backend`. (The instance `chooseBackend()` should delegate to this pure function so there is one source of truth.)

**C3.4 (major) — Task 4 track-end poll must NOT fire at startup.** In `rust-librespot.ts` `pollState()`, gate the progress-based end condition on `this.hasPlayed` like the other two: `const finishedByProgress = this.hasPlayed && state.durationMs > 0 && state.progressMs >= state.durationMs - END_OF_TRACK_WINDOW_MS;`. Otherwise the first poll (before the bot ever calls `playTrack`) can observe the account's own stale/paused track already near its end and spuriously emit `trackEnded`, wrongly advancing the queue. Only emit any end signal after the bot's own track has been seen playing (`hasPlayed`).

**C3.5 (minor) — Task 4 poll: treat a post-playback 204 as track-end.** `pollState()` currently early-returns on a null state (204 / no active device). After the bot's track has played, librespot going idle returns 204, so the queue would stall (no `trackEnded`). Fix: when `!state && this.hasPlayed && this.currentUri && !this.endedForCurrent`, emit `trackEnded` for `this.currentUri` (reason "ended") and reset, instead of an unconditional early return. (Before any play, a null state still just returns.)

**C3.6 (minor) — Task 3 Connect API: mutating calls must not throw up the queue path.** `transfer/play/pause/resume/seek` currently have no try/catch, so a 403 (non-Premium)/404 (no device)/429 (rate-limit) rejects and propagates, making `playTrack` throw an unhandled rejection. Wrap each mutating PUT in try/catch that logs and either swallows or throws a typed error the controller/backend can classify — so a transient failure degrades gracefully (the backend can retry/fallback) rather than crashing the advance path.

**C3.7 (minor) — Task 2 OAuth: always clear the PKCE verifier for a state.** In `handleCallback`, `pendingVerifiers.delete(state)` runs only on success, so failed logins leak Map entries. Use `try { … } finally { this.pendingVerifiers.delete(state); }` around the token exchange so the verifier is removed on every terminal path.

## File structure

**New:** `src/music/spotify/{spotify-oauth,connect-api,rust-librespot}.ts` (+ tests); `src/web/api/spotify.ts` (+ test).
**Modified:** `src/music/spotify/binary.ts` (Rust resolver fns), `src/music/spotify/controller.ts` (chooseBackend + OAuth/Connect ownership + rust-needs-auth gate), `src/web/server.ts` (mount router), `src/index.ts` (+ maybe `src/bot/manager.ts`) to construct/expose the controller's OAuth, and possibly `src/data/config.ts` (only if a new field is truly needed — prefer reusing `spotify.clientId`).

---

### Task 1: Rust librespot binary resolver

Append the Rust-librespot resolver functions to the existing Stage-2 `binary.ts`, mirroring the go-librespot functions already in that file. Unlike go-librespot (Linux-only release binaries + POSIX FIFO), Rust librespot's `--backend pipe` writes PCM to **stdout** on every platform, so `isRustLibrespotSupported()` is unconditionally `true` and `findLibrespot()` must resolve `librespot.exe` on win32.

**Files:**
- MODIFY `src/music/spotify/binary.ts` — append `isRustLibrespotSupported`, `pickLibrespotPath`, `findLibrespot`, `checkLibrespotAvailable`, `resetLibrespotBinaryCache`, `__setLibrespotVersionProbe` (test hook). Do NOT touch the existing go-librespot exports.
- MODIFY `src/music/spotify/binary.test.ts` — append a `describe` block per new function (mocked/unit-level; no real binary).

**Interfaces:**

Consumes (existing module internals, reuse verbatim — already imported at the top of `binary.ts`):
```ts
import { execFile } from "node:child_process";  // via execFileAsync = promisify(execFile)
import { existsSync } from "node:fs";
import { join } from "node:path";
// __dirname = dirname(fileURLToPath(import.meta.url))  — already defined in the file
```

Produces (append to `binary.ts`; these exact signatures are the LOCKED CONTRACT):
```ts
export function isRustLibrespotSupported(): boolean            // true on ALL platforms
export function pickLibrespotPath(candidates: string[], exists: (p: string) => boolean): string  // pure resolver core (mirrors pickGoLibrespotPath)
export function findLibrespot(): string                       // bin/librespot(.exe) then PATH
export function resetLibrespotBinaryCache(): void
export async function checkLibrespotAvailable(): Promise<boolean>   // `librespot --version` runs
export function __setLibrespotVersionProbe(probe: ((bin: string) => Promise<void>) | null): void  // test hook
```

Note: `pickLibrespotPath` is not named in the contract but is added (exported) to mirror the existing `pickGoLibrespotPath` seam so the win32-exe path-ordering is unit-testable without a real binary — consistent with the file's established convention.

---

Bite-sized steps (TDD — write the failing test, then the code, per checkbox):

- [ ] **Step 1 — RED: platform-support test.** Append to `src/music/spotify/binary.test.ts`. First extend the import at the top of the file to also pull the new symbols:

  ```ts
  import {
    isRustLibrespotSupported,
    pickLibrespotPath,
    findLibrespot,
    checkLibrespotAvailable,
    resetLibrespotBinaryCache,
    __setLibrespotVersionProbe,
  } from "./binary.js";
  ```

  Extend the existing `afterEach` to also reset the Rust state (add these two lines inside the existing `afterEach` body):

  ```ts
    __setLibrespotVersionProbe(null);
    resetLibrespotBinaryCache();
  ```

  Then append the block:

  ```ts
  describe("isRustLibrespotSupported", () => {
    it("is true on every platform (pipe->stdout works everywhere)", () => {
      setPlatform("linux");
      expect(isRustLibrespotSupported()).toBe(true);
      setPlatform("win32");
      expect(isRustLibrespotSupported()).toBe(true);
      setPlatform("darwin");
      expect(isRustLibrespotSupported()).toBe(true);
    });
  });
  ```

  Run `npx vitest run src/music/spotify/binary.test.ts` — EXPECT: fails to compile / import error (symbols not exported yet).

- [ ] **Step 2 — GREEN: append `isRustLibrespotSupported` + `pickLibrespotPath` to `binary.ts`.** Append at the end of `src/music/spotify/binary.ts` (after `resetGoLibrespotBinaryCache`):

  ```ts
  // ---------------------------------------------------------------------------
  // Rust librespot (librespot-org) resolver — mirrors the go-librespot fns
  // above. Unlike go-librespot, Rust librespot's `--backend pipe` writes PCM to
  // *stdout* on every platform (no FIFO, no audio device), so it is supported
  // on Windows/macOS/Linux alike and the binary is named librespot.exe on win32.
  // ---------------------------------------------------------------------------

  /**
   * True on ALL platforms. The Rust librespot pipe backend writes raw bytes to
   * process stdout, which Node's spawned child.stdout receives unmodified on
   * Windows too — so there is no platform gate here (contrast
   * isGoLibrespotSupported, which is Linux-only).
   */
  export function isRustLibrespotSupported(): boolean {
    return true;
  }

  /**
   * Pure resolver core behind findLibrespot(). Returns the first candidate that
   * is either a bare command name (left for execFile to resolve via PATH) or an
   * existing bin/ file. Exported so tests can inject candidates + a fake
   * existence predicate and need no real binary on disk. Mirrors
   * pickGoLibrespotPath but keys off the win32 exe name.
   */
  export function pickLibrespotPath(
    candidates: string[],
    exists: (p: string) => boolean,
  ): string {
    const exe = process.platform === "win32" ? "librespot.exe" : "librespot";
    for (const c of candidates) {
      // bin/ paths only count when the file is actually present; bare names are
      // returned unconditionally and resolved later via PATH.
      const isBinPath = c.includes(join("bin", "librespot"));
      if (!isBinPath || exists(c)) return c;
    }
    return exe;
  }
  ```

  Run `npx vitest run src/music/spotify/binary.test.ts` — EXPECT: the `isRustLibrespotSupported` block passes (the rest of the new blocks don't exist yet).

- [ ] **Step 3 — RED: path-ordering + win32 exe-name tests.** Append to `binary.test.ts`:

  ```ts
  describe("pickLibrespotPath (bin/ then PATH ordering, win32 exe)", () => {
    it("prefers the bin/ path when the file exists", () => {
      const binPath = join("some", "root", "bin", "librespot");
      expect(
        pickLibrespotPath([binPath, "librespot"], (p) => p === binPath),
      ).toBe(binPath);
    });

    it("prefers the bin/librespot.exe path on win32 when it exists", () => {
      setPlatform("win32");
      const binExe = join("some", "root", "bin", "librespot.exe");
      expect(
        pickLibrespotPath([binExe, "librespot.exe"], (p) => p === binExe),
      ).toBe(binExe);
    });

    it("falls through to the bare PATH name (librespot) on posix when bin/ is missing", () => {
      setPlatform("linux");
      const binPath = join("some", "root", "bin", "librespot");
      expect(pickLibrespotPath([binPath, "librespot"], () => false)).toBe(
        "librespot",
      );
    });

    it("falls through to librespot.exe on win32 when bin/ is missing", () => {
      setPlatform("win32");
      const binExe = join("some", "root", "bin", "librespot.exe");
      expect(pickLibrespotPath([binExe], () => false)).toBe("librespot.exe");
    });

    it("returns bare command names without touching the filesystem", () => {
      const exists = vi.fn(() => false);
      expect(pickLibrespotPath(["librespot"], exists)).toBe("librespot");
      expect(exists).not.toHaveBeenCalled();
    });
  });

  describe("findLibrespot", () => {
    it("returns the bare command name when bin/librespot is absent", () => {
      // No librespot binary is committed under bin/, so resolution must fall
      // back to the bare PATH name (execFile resolves it at run time).
      setPlatform("linux");
      expect(findLibrespot()).toBe("librespot");
    });

    it("returns librespot.exe on win32 when bin/librespot.exe is absent", () => {
      setPlatform("win32");
      expect(findLibrespot()).toBe("librespot.exe");
    });
  });
  ```

  Run `npx vitest run src/music/spotify/binary.test.ts` — EXPECT: the `pickLibrespotPath`/`findLibrespot` blocks fail (`findLibrespot` not exported yet).

- [ ] **Step 4 — GREEN: append `findLibrespot` to `binary.ts`.** Append after `pickLibrespotPath`:

  ```ts
  /**
   * Resolve the Rust librespot binary path: project bin/ dir first, then PATH.
   * On win32 both the bin/librespot.exe candidate and the bare "librespot.exe"
   * fallback are used so a PATH-installed librespot.exe (scoop/choco) resolves.
   */
  export function findLibrespot(): string {
    const exe = process.platform === "win32" ? "librespot.exe" : "librespot";
    // src/music/spotify -> ../../../bin (same depth as findGoLibrespot).
    const binExe = join(__dirname, "..", "..", "..", "bin", exe);
    const binBare = join(__dirname, "..", "..", "..", "bin", "librespot");
    return pickLibrespotPath([binExe, binBare, exe], existsSync);
  }
  ```

  Run `npx vitest run src/music/spotify/binary.test.ts` — EXPECT: all `pickLibrespotPath` + `findLibrespot` tests pass.

- [ ] **Step 5 — RED: availability-cache tests.** Append to `binary.test.ts`:

  ```ts
  describe("checkLibrespotAvailable", () => {
    it("returns true when the binary responds to --version (any platform)", async () => {
      setPlatform("win32");
      __setLibrespotVersionProbe(async () => {});
      expect(await checkLibrespotAvailable()).toBe(true);
    });

    it("returns true on darwin too (no platform gate)", async () => {
      setPlatform("darwin");
      __setLibrespotVersionProbe(async () => {});
      expect(await checkLibrespotAvailable()).toBe(true);
    });

    it("caches only positive results and probes once", async () => {
      setPlatform("linux");
      const probe = vi.fn(async () => {});
      __setLibrespotVersionProbe(probe);
      expect(await checkLibrespotAvailable()).toBe(true);
      expect(await checkLibrespotAvailable()).toBe(true);
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it("does not cache a failed probe (retries on the next call)", async () => {
      setPlatform("win32");
      __setLibrespotVersionProbe(async () => {
        throw new Error("ENOENT");
      });
      expect(await checkLibrespotAvailable()).toBe(false);
      __setLibrespotVersionProbe(async () => {});
      expect(await checkLibrespotAvailable()).toBe(true);
    });

    it("resetLibrespotBinaryCache clears a cached positive", async () => {
      setPlatform("linux");
      __setLibrespotVersionProbe(async () => {});
      expect(await checkLibrespotAvailable()).toBe(true);
      resetLibrespotBinaryCache();
      __setLibrespotVersionProbe(async () => {
        throw new Error("gone");
      });
      expect(await checkLibrespotAvailable()).toBe(false);
    });

    it("de-dupes concurrent in-flight probes", async () => {
      setPlatform("linux");
      const probe = vi.fn(async () => {});
      __setLibrespotVersionProbe(probe);
      const [a, b] = await Promise.all([
        checkLibrespotAvailable(),
        checkLibrespotAvailable(),
      ]);
      expect(a).toBe(true);
      expect(b).toBe(true);
      expect(probe).toHaveBeenCalledTimes(1);
    });
  });
  ```

  Run `npx vitest run src/music/spotify/binary.test.ts` — EXPECT: the `checkLibrespotAvailable` block fails (not exported yet).

- [ ] **Step 6 — GREEN: append the probe + cache to `binary.ts`.** Append after `findLibrespot`. Note: use module-scoped state names distinct from the go-librespot ones (`rustCachedAvailable`, `rustPendingCheck`) so the two caches never collide:

  ```ts
  // Injectable `--version` probe. Defaults to the real execFile call; tests
  // override it so checkLibrespotAvailable() needs no real binary. Keeps the
  // public checkLibrespotAvailable() signature param-free per the contract.
  type LibrespotVersionProbe = (bin: string) => Promise<void>;
  const realLibrespotProbe: LibrespotVersionProbe = async (bin) => {
    await execFileAsync(bin, ["--version"], { timeout: 5_000, maxBuffer: 1024 });
  };
  let librespotVersionProbe: LibrespotVersionProbe = realLibrespotProbe;

  /** Test hook: override the `--version` probe, or restore the default with null. */
  export function __setLibrespotVersionProbe(
    probe: LibrespotVersionProbe | null,
  ): void {
    librespotVersionProbe = probe ?? realLibrespotProbe;
  }

  /**
   * Availability check for Rust librespot. No platform gate (supported
   * everywhere). Runs `librespot --version` (5s timeout) and caches ONLY the
   * positive result — a missing binary is retried on the next call so the
   * operator can install it (cargo/scoop/choco) without restarting the server.
   */
  let rustCachedAvailable = false;
  let rustPendingCheck: Promise<boolean> | null = null;
  export async function checkLibrespotAvailable(): Promise<boolean> {
    if (!isRustLibrespotSupported()) return false;
    if (rustCachedAvailable) return true;
    if (rustPendingCheck) return rustPendingCheck;
    rustPendingCheck = (async () => {
      try {
        await librespotVersionProbe(findLibrespot());
        rustCachedAvailable = true;
        return true;
      } catch {
        return false;
      } finally {
        rustPendingCheck = null;
      }
    })();
    return rustPendingCheck;
  }

  /** Force re-detection on the next call (for tests). */
  export function resetLibrespotBinaryCache(): void {
    rustCachedAvailable = false;
    rustPendingCheck = null;
  }
  ```

  Run `npx vitest run src/music/spotify/binary.test.ts` — EXPECT: all blocks pass (both the pre-existing go-librespot tests and the new Rust ones).

- [ ] **Step 7 — Full verify.**
  - `npx vitest run src/music/spotify/binary.test.ts` — EXPECT: all tests green (existing go-librespot suite + new Rust suite), 0 failures.
  - `npx tsc --noEmit` — EXPECT: no errors (clean exit 0). Confirms the appended ESM `.js`-import module type-checks and no symbol/name collisions with the go-librespot exports.
  - Optionally `npx vitest run` to confirm no sibling Stage-2 spotify tests regressed.

- [ ] **Step 8 — Commit.**
  ```bash
  git add src/music/spotify/binary.ts src/music/spotify/binary.test.ts
  git commit -m "$(cat <<'EOF'
  feat(spotify): add Rust librespot binary resolver (Stage 3 Task 1)

  Append isRustLibrespotSupported/pickLibrespotPath/findLibrespot/
  checkLibrespotAvailable/resetLibrespotBinaryCache to binary.ts, mirroring
  the go-librespot resolver. Supported on all platforms (pipe->stdout),
  resolves librespot.exe on win32, caches only positive --version probes.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

Notes / guardrails for the implementer:
- This is Windows-targeted and NOT e2e-testable (no Premium account, no real binary/network) — every test injects the `__setLibrespotVersionProbe` hook and `setPlatform`, so no `librespot` binary or network is ever touched.
- Do NOT modify or reuse the go-librespot module state (`cachedAvailable`/`pendingCheck`) — the Rust cache uses its own `rustCachedAvailable`/`rustPendingCheck` to avoid cross-contaminating the two availability checks.
- Keep the append purely additive: the existing Stage-2 exports and their tests must remain byte-for-byte unchanged (the only edit to the existing test file is extending the shared import statement and the shared `afterEach`).

---

### Task 2: Spotify OAuth (Authorization Code + PKCE)

**Files:**
- CREATE `src/music/spotify/spotify-oauth.ts`
- CREATE `src/music/spotify/spotify-oauth.test.ts`

**Interfaces:**

*Consumes:*
- `axios` → `import axios, { type AxiosInstance } from "axios"` — injected via `deps.http` (mirrors `webapi.ts` line 1), default `axios.create({ baseURL: "https://accounts.spotify.com", timeout: 15_000 })`.
- `node:crypto` → `createHash`, `randomBytes` (PKCE S256 + state/verifier generation; no network).
- `node:fs` / `node:path` → for the concrete `createFileOAuthTokenStore` only.

*Produces (exact, per LOCKED CONTRACT):*
```ts
export const LIBRESPOT_PUBLIC_CLIENT_ID = "65b708073fc0480ea92a077233ca87bd"
export const LIBRESPOT_REDIRECT_URI = "http://127.0.0.1:5588/login"
export const SPOTIFY_CONTROL_SCOPES = "streaming user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private"
export interface OAuthTokens { accessToken: string; refreshToken: string; expiresAt: number; scope: string }
export interface OAuthTokenStore { load(): OAuthTokens | null; save(t: OAuthTokens): void; clear(): void }
export interface SpotifyOAuthOptions { clientId?: string; redirectUri?: string; store: OAuthTokenStore; deps?: { http?: import("axios").AxiosInstance } }
export function generateCodeVerifier(): string            // helper — 64 url-safe chars
export function codeChallengeS256(verifier: string): string // helper — base64url(sha256), no padding
export function createFileOAuthTokenStore(filePath: string): OAuthTokenStore
export class SpotifyOAuth {
  constructor(o: SpotifyOAuthOptions)
  getClientId(): string
  getRedirectUri(): string
  isAuthorized(): boolean
  buildAuthorizeUrl(): { url: string; state: string }
  handleCallback(code: string, state: string): Promise<boolean>
  getAccessToken(): Promise<string | null>
}
```

*Contract binding rules (from research map §OAuth):* PKCE verifier 43–128 chars from `[A-Za-z0-9-._~]` (we use 64); `code_challenge = base64url(SHA256(verifier))` no padding, `code_challenge_method=S256`; loopback redirect `http://127.0.0.1:5588/login` (NOT `localhost`); token endpoint is form-encoded, public client (no `client_secret`); refresh **rotates** the refresh token → always persist the newest; HTTP 400 `error=invalid_grant` → discard stored token (clear store) and return `null`.

---

- [ ] **Step 1 — Write the failing test first** (`src/music/spotify/spotify-oauth.test.ts`). Mocks the injected `http` (axios) — **no real network** — and independently recomputes the S256 challenge with `node:crypto` to prove the verifier→challenge binding end-to-end.

```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SpotifyOAuth,
  LIBRESPOT_PUBLIC_CLIENT_ID,
  LIBRESPOT_REDIRECT_URI,
  SPOTIFY_CONTROL_SCOPES,
  generateCodeVerifier,
  codeChallengeS256,
  createFileOAuthTokenStore,
  type OAuthTokens,
  type OAuthTokenStore,
} from "./spotify-oauth.js";

/** In-memory store exposing `.value` so tests can assert persistence. */
function memStore(
  initial: OAuthTokens | null = null,
): OAuthTokenStore & { value: OAuthTokens | null } {
  const s = {
    value: initial,
    load() {
      return s.value;
    },
    save(t: OAuthTokens) {
      s.value = t;
    },
    clear() {
      s.value = null;
    },
  };
  return s;
}

describe("PKCE helpers", () => {
  it("generateCodeVerifier returns 64 chars from the unreserved set", () => {
    const v = generateCodeVerifier();
    expect(v).toHaveLength(64);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    expect(generateCodeVerifier()).not.toBe(v); // random
  });

  it("codeChallengeS256 is base64url(sha256) with no padding (43 chars)", () => {
    const c = codeChallengeS256("abc123");
    expect(c).toHaveLength(43); // 32-byte digest -> 43 base64url chars
    expect(c).not.toContain("=");
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("SpotifyOAuth.buildAuthorizeUrl", () => {
  it("builds accounts.spotify.com/authorize with the librespot defaults + S256", () => {
    const oauth = new SpotifyOAuth({ store: memStore() });
    const { url, state } = oauth.buildAuthorizeUrl();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.spotify.com/authorize");
    const p = u.searchParams;
    expect(p.get("client_id")).toBe(LIBRESPOT_PUBLIC_CLIENT_ID);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe(LIBRESPOT_REDIRECT_URI);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toHaveLength(43);
    expect(p.get("scope")).toBe(SPOTIFY_CONTROL_SCOPES);
    expect(p.get("state")).toBe(state);
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(oauth.getClientId()).toBe(LIBRESPOT_PUBLIC_CLIENT_ID);
    expect(oauth.getRedirectUri()).toBe(LIBRESPOT_REDIRECT_URI);
  });

  it("honors a custom clientId + redirectUri", () => {
    const oauth = new SpotifyOAuth({
      clientId: "myapp",
      redirectUri: "http://127.0.0.1:9000/callback",
      store: memStore(),
    });
    const { url } = oauth.buildAuthorizeUrl();
    const p = new URL(url).searchParams;
    expect(p.get("client_id")).toBe("myapp");
    expect(p.get("redirect_uri")).toBe("http://127.0.0.1:9000/callback");
  });
});

describe("SpotifyOAuth.handleCallback", () => {
  it("exchanges the code (PKCE verifier matches the authorize challenge) and persists tokens", async () => {
    const store = memStore();
    const http = {
      post: vi.fn().mockResolvedValue({
        data: {
          access_token: "a1",
          refresh_token: "r1",
          expires_in: 3600,
          scope: SPOTIFY_CONTROL_SCOPES,
        },
      }),
    } as any;
    const oauth = new SpotifyOAuth({ store, deps: { http } });

    const { url, state } = oauth.buildAuthorizeUrl();
    const challenge = new URL(url).searchParams.get("code_challenge")!;

    const ok = await oauth.handleCallback("CODE123", state);
    expect(ok).toBe(true);

    const [path, bodyStr, cfg] = http.post.mock.calls[0];
    expect(path).toBe("/api/token");
    expect(cfg.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(bodyStr as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("CODE123");
    expect(body.get("redirect_uri")).toBe(LIBRESPOT_REDIRECT_URI);
    expect(body.get("client_id")).toBe(LIBRESPOT_PUBLIC_CLIENT_ID);
    // The verifier sent MUST hash to the challenge advertised in the authorize URL.
    const verifier = body.get("code_verifier")!;
    expect(codeChallengeS256(verifier)).toBe(challenge);

    expect(store.value?.accessToken).toBe("a1");
    expect(store.value?.refreshToken).toBe("r1");
    expect(store.value?.expiresAt).toBeGreaterThan(Date.now());
    expect(oauth.isAuthorized()).toBe(true);
  });

  it("rejects an unknown state without calling the token endpoint (CSRF guard)", async () => {
    const http = { post: vi.fn() } as any;
    const oauth = new SpotifyOAuth({ store: memStore(), deps: { http } });
    expect(await oauth.handleCallback("CODE", "not-a-real-state")).toBe(false);
    expect(http.post).not.toHaveBeenCalled();
  });
});

describe("SpotifyOAuth.getAccessToken", () => {
  it("returns the cached token without refreshing when still valid", async () => {
    const http = { post: vi.fn() } as any;
    const store = memStore({
      accessToken: "cached",
      refreshToken: "r1",
      expiresAt: Date.now() + 60_000,
      scope: "s",
    });
    const oauth = new SpotifyOAuth({ store, deps: { http } });
    expect(await oauth.getAccessToken()).toBe("cached");
    expect(http.post).not.toHaveBeenCalled();
  });

  it("refreshes when expired and persists the ROTATED refresh token", async () => {
    const store = memStore({
      accessToken: "old",
      refreshToken: "r1",
      expiresAt: Date.now() - 1000,
      scope: "s",
    });
    const http = {
      post: vi.fn().mockResolvedValue({
        data: { access_token: "a2", refresh_token: "r2", expires_in: 3600 },
      }),
    } as any;
    const oauth = new SpotifyOAuth({ store, deps: { http } });

    expect(await oauth.getAccessToken()).toBe("a2");
    const body = new URLSearchParams(http.post.mock.calls[0][1] as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("r1");
    expect(body.get("client_id")).toBe(LIBRESPOT_PUBLIC_CLIENT_ID);
    expect(store.value?.refreshToken).toBe("r2"); // rotated + persisted
    expect(store.value?.accessToken).toBe("a2");
  });

  it("keeps the old refresh token when the refresh response omits a new one", async () => {
    const store = memStore({
      accessToken: "old",
      refreshToken: "r1",
      expiresAt: Date.now() - 1000,
      scope: "s",
    });
    const http = {
      post: vi.fn().mockResolvedValue({ data: { access_token: "a2", expires_in: 3600 } }),
    } as any;
    const oauth = new SpotifyOAuth({ store, deps: { http } });
    expect(await oauth.getAccessToken()).toBe("a2");
    expect(store.value?.refreshToken).toBe("r1");
  });

  it("clears the store and returns null on invalid_grant (expired refresh token)", async () => {
    const store = memStore({
      accessToken: "old",
      refreshToken: "r1",
      expiresAt: Date.now() - 1000,
      scope: "s",
    });
    const http = {
      post: vi.fn().mockRejectedValue({
        response: { status: 400, data: { error: "invalid_grant" } },
      }),
    } as any;
    const oauth = new SpotifyOAuth({ store, deps: { http } });
    expect(await oauth.getAccessToken()).toBeNull();
    expect(store.value).toBeNull();
    expect(oauth.isAuthorized()).toBe(false);
  });

  it("returns null when unauthorized (no stored refresh token)", async () => {
    const http = { post: vi.fn() } as any;
    const oauth = new SpotifyOAuth({ store: memStore(), deps: { http } });
    expect(await oauth.getAccessToken()).toBeNull();
    expect(oauth.isAuthorized()).toBe(false);
    expect(http.post).not.toHaveBeenCalled();
  });
});

describe("createFileOAuthTokenStore", () => {
  it("round-trips save/load and clear() removes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "sp-oauth-"));
    const file = join(dir, "nested", "tokens.json");
    try {
      const store = createFileOAuthTokenStore(file);
      expect(store.load()).toBeNull(); // missing file
      const t: OAuthTokens = {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 123,
        scope: "s",
      };
      store.save(t);
      expect(store.load()).toEqual(t);
      store.clear();
      expect(store.load()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Run it and confirm it fails (module not found / red):
```
npx vitest run src/music/spotify/spotify-oauth.test.ts
```
Expected: FAIL — `Failed to resolve import "./spotify-oauth.js"` (implementation not written yet).

- [ ] **Step 2 — Implement `src/music/spotify/spotify-oauth.ts`** (complete, ESM `.js`-import-correct file). Mirrors `webapi.ts` axios-injection conventions; PKCE via `node:crypto`.

```ts
import axios, { type AxiosInstance } from "axios";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const LIBRESPOT_PUBLIC_CLIENT_ID = "65b708073fc0480ea92a077233ca87bd";
export const LIBRESPOT_REDIRECT_URI = "http://127.0.0.1:5588/login";
export const SPOTIFY_CONTROL_SCOPES =
  "streaming user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private";

const ACCOUNTS_BASE = "https://accounts.spotify.com";
// Hand a token back only if it survives ~30s, matching webapi.ts's skew.
const EXPIRY_SKEW_MS = 30_000;
// RFC 7636 §4.1 unreserved set: [A-Za-z0-9-._~].
const PKCE_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

export interface OAuthTokenStore {
  load(): OAuthTokens | null;
  save(t: OAuthTokens): void;
  clear(): void;
}

export interface SpotifyOAuthOptions {
  clientId?: string;
  redirectUri?: string;
  store: OAuthTokenStore;
  deps?: { http?: AxiosInstance };
}

/** 64 random chars from the PKCE unreserved set (43-128 allowed by the spec). */
export function generateCodeVerifier(): string {
  const bytes = randomBytes(64);
  let out = "";
  for (let i = 0; i < 64; i++) out += PKCE_CHARS[bytes[i] % PKCE_CHARS.length];
  return out;
}

/** base64url(SHA256(verifier)) with no padding — the S256 code challenge. */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Persist OAuth tokens as a 0600 JSON file (used by the controller). */
export function createFileOAuthTokenStore(filePath: string): OAuthTokenStore {
  return {
    load() {
      try {
        if (!existsSync(filePath)) return null;
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        return parsed?.refreshToken ? (parsed as OAuthTokens) : null;
      } catch {
        return null; // missing/corrupt -> treat as unauthorized
      }
    },
    save(t: OAuthTokens) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(t, null, 2), { mode: 0o600 });
    },
    clear() {
      try {
        rmSync(filePath, { force: true });
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Authorization Code + PKCE flow for the USER player-control token. Public
 * client (no secret): the librespot keymaster client_id + loopback redirect by
 * default, or a caller-registered app. Refresh rotates the refresh token, so
 * the newest is always persisted; invalid_grant clears the store (re-login).
 */
export class SpotifyOAuth {
  private clientId: string;
  private redirectUri: string;
  private store: OAuthTokenStore;
  private http: AxiosInstance;
  // Pending PKCE verifiers keyed by state, awaiting the loopback redirect back.
  private pendingVerifiers = new Map<string, string>();

  constructor(o: SpotifyOAuthOptions) {
    this.clientId = o.clientId ?? LIBRESPOT_PUBLIC_CLIENT_ID;
    this.redirectUri = o.redirectUri ?? LIBRESPOT_REDIRECT_URI;
    this.store = o.store;
    this.http =
      o.deps?.http ?? axios.create({ baseURL: ACCOUNTS_BASE, timeout: 15_000 });
  }

  getClientId(): string {
    return this.clientId;
  }

  getRedirectUri(): string {
    return this.redirectUri;
  }

  isAuthorized(): boolean {
    return !!this.store.load()?.refreshToken;
  }

  buildAuthorizeUrl(): { url: string; state: string } {
    const state = randomBytes(16).toString("hex");
    const verifier = generateCodeVerifier();
    this.pendingVerifiers.set(state, verifier);
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri,
      code_challenge: codeChallengeS256(verifier),
      code_challenge_method: "S256",
      scope: SPOTIFY_CONTROL_SCOPES,
      state,
    });
    return { url: `${ACCOUNTS_BASE}/authorize?${params.toString()}`, state };
  }

  async handleCallback(code: string, state: string): Promise<boolean> {
    const verifier = this.pendingVerifiers.get(state);
    if (!verifier) return false; // unknown/expired state -> CSRF guard
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: verifier,
    });
    try {
      const { data } = await this.http.post("/api/token", body.toString(), {
        headers: FORM_HEADERS,
      });
      if (!data?.access_token || !data?.refresh_token) return false;
      this.store.save(this.toTokens(data, data.refresh_token, data.scope));
      this.pendingVerifiers.delete(state);
      return true;
    } catch {
      return false;
    }
  }

  async getAccessToken(): Promise<string | null> {
    const tokens = this.store.load();
    if (!tokens?.refreshToken) return null; // unauthorized
    if (tokens.accessToken && Date.now() < tokens.expiresAt) {
      return tokens.accessToken;
    }
    return this.refresh(tokens);
  }

  private async refresh(current: OAuthTokens): Promise<string | null> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: this.clientId,
    });
    try {
      const { data } = await this.http.post("/api/token", body.toString(), {
        headers: FORM_HEADERS,
      });
      if (!data?.access_token) return null;
      // PKCE rotates the refresh token; fall back to the current one if omitted.
      const rotated = data.refresh_token || current.refreshToken;
      const saved = this.toTokens(data, rotated, data.scope ?? current.scope);
      this.store.save(saved);
      return saved.accessToken;
    } catch (err: any) {
      // invalid_grant => refresh token revoked/expired: discard, force re-login.
      if (err?.response?.data?.error === "invalid_grant") this.store.clear();
      return null;
    }
  }

  private toTokens(data: any, refreshToken: string, scope: string): OAuthTokens {
    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - EXPIRY_SKEW_MS,
      scope: scope ?? SPOTIFY_CONTROL_SCOPES,
    };
  }
}
```

- [ ] **Step 3 — Run the test suite to green.**
```
npx vitest run src/music/spotify/spotify-oauth.test.ts
```
Expected: PASS — all describe blocks green (PKCE helpers, buildAuthorizeUrl defaults + custom, handleCallback exchange/CSRF, getAccessToken cache/rotate/keep-old/invalid_grant/unauthorized, file store round-trip).

- [ ] **Step 4 — Type-check the whole project (no emit).**
```
npx tsc --noEmit
```
Expected: exit 0, no errors (ESM `.js` import specifiers resolve; `axios`/`node:crypto`/`node:fs` types clean).

- [ ] **Step 5 — Commit.**
```
git add src/music/spotify/spotify-oauth.ts src/music/spotify/spotify-oauth.test.ts
git commit -m "$(cat <<'EOF'
feat(spotify): add SpotifyOAuth Authorization Code + PKCE control-token flow

Stage 3 Task 2. PKCE (S256) authorize URL, code exchange, and refresh with
rotated-refresh-token persistence + invalid_grant store-clear. axios/http and
token store injected for fully mocked, network-free unit tests.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

*Note: Windows-targeted, not e2e-testable (no Premium account / no live Spotify auth) — all tests are mocked unit-level, injecting `http` (axios) and using `node:crypto` for real PKCE math with zero network calls.*

---

### Task 3: Spotify Connect control API client

**Files:**
- CREATE `src/music/spotify/connect-api.ts` — `SpotifyConnectApi` wrapping an injected `AxiosInstance` with a Bearer token from `getToken()`.
- CREATE `src/music/spotify/connect-api.test.ts` — Vitest unit tests with a mocked axios instance (no network); asserts method + path + params + body + `Authorization` header for every call.

**Interfaces:**

_Consumes:_
- `getToken: () => Promise<string | null>` — supplied by the controller-owned `SpotifyOAuth` (Task 2). Returns a valid user access token or `null` when unauthorized.
- `import("axios").AxiosInstance` — injected via `deps.http` for tests; defaults to `axios.create({ baseURL: "https://api.spotify.com", timeout: 15_000 })` (mirrors `webapi.ts`).

_Produces (exact signatures — verbatim from the locked contract):_
```ts
export interface SpotifyDevice { id: string; name: string; is_active: boolean }
export interface PlaybackState { isPlaying: boolean; progressMs: number; trackUri: string | null; durationMs: number }
export class SpotifyConnectApi {
  constructor(getToken: () => Promise<string | null>, deps?: { http?: import("axios").AxiosInstance })
  getDevices(): Promise<SpotifyDevice[]>                        // GET /v1/me/player/devices
  findDeviceByName(name: string): Promise<string | null>       // matching device id or null
  transfer(deviceId: string, play?: boolean): Promise<void>    // PUT /v1/me/player {device_ids:[id], play}
  play(deviceId: string, trackUri: string): Promise<void>      // PUT /v1/me/player/play?device_id={id} {uris:[uri]}
  pause(deviceId?: string): Promise<void>                      // PUT /v1/me/player/pause
  resume(deviceId?: string): Promise<void>                     // PUT /v1/me/player/play
  seek(ms: number, deviceId?: string): Promise<void>           // PUT /v1/me/player/seek?position_ms={ms}
  getPlaybackState(): Promise<PlaybackState | null>            // GET /v1/me/player (null on 204 = no active device)
}
```
Consumed downstream by `RustLibrespotBackend` (Task 4/5) and `controller.ts` (Task 7).

---

**Steps (TDD — write the test file first, watch it fail, then implement):**

- [ ] **Write the failing test file** `src/music/spotify/connect-api.test.ts`. Note the ESM `.js` import specifier and the `makeHttp` axios stub style copied from `go-librespot-api.test.ts` (only `get`/`put` are exercised):

```ts
import { describe, it, expect, vi } from "vitest";
import type { AxiosInstance } from "axios";
import { SpotifyConnectApi } from "./connect-api.js";

/** Minimal axios stub: only get/put are exercised by the Connect client. */
function makeHttp(overrides?: Partial<Record<"get" | "put", any>>) {
  return {
    get: vi.fn().mockResolvedValue({ status: 200, data: {} }),
    put: vi.fn().mockResolvedValue({ status: 200, data: {} }),
    ...overrides,
  } as unknown as AxiosInstance;
}

const AUTH = { headers: { Authorization: "Bearer tok123" } };
const token = () => vi.fn<[], Promise<string | null>>().mockResolvedValue("tok123");

describe("SpotifyConnectApi.getDevices", () => {
  it("GETs /v1/me/player/devices with the bearer header and maps the list", async () => {
    const http = makeHttp({
      get: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          devices: [
            { id: "dev-1", name: "TS Bot", is_active: true, type: "Speaker" },
            { id: "dev-2", name: "Phone", is_active: false },
          ],
        },
      }),
    });
    const api = new SpotifyConnectApi(token(), { http });
    const devices = await api.getDevices();
    expect(http.get).toHaveBeenCalledWith("/v1/me/player/devices", AUTH);
    expect(devices).toEqual([
      { id: "dev-1", name: "TS Bot", is_active: true },
      { id: "dev-2", name: "Phone", is_active: false },
    ]);
  });

  it("returns [] when getToken() is null (unauthorized) without calling http", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(vi.fn().mockResolvedValue(null), { http });
    await expect(api.getDevices()).resolves.toEqual([]);
    expect(http.get).not.toHaveBeenCalled();
  });

  it("returns [] on a 401/network rejection (graceful)", async () => {
    const err: any = new Error("unauthorized");
    err.response = { status: 401 };
    const http = makeHttp({ get: vi.fn().mockRejectedValue(err) });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.getDevices()).resolves.toEqual([]);
  });
});

describe("SpotifyConnectApi.findDeviceByName", () => {
  it("returns the matching device id", async () => {
    const http = makeHttp({
      get: vi.fn().mockResolvedValue({
        status: 200,
        data: { devices: [{ id: "dev-1", name: "TS Bot", is_active: false }] },
      }),
    });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.findDeviceByName("TS Bot")).resolves.toBe("dev-1");
  });

  it("returns null when no device name matches", async () => {
    const http = makeHttp({
      get: vi.fn().mockResolvedValue({
        status: 200,
        data: { devices: [{ id: "dev-1", name: "Other", is_active: false }] },
      }),
    });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.findDeviceByName("TS Bot")).resolves.toBeNull();
  });
});

describe("SpotifyConnectApi mutating calls", () => {
  it("transfer() PUTs /v1/me/player with device_ids + play=false default", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.transfer("dev-1");
    expect(http.put).toHaveBeenCalledWith(
      "/v1/me/player",
      { device_ids: ["dev-1"], play: false },
      AUTH,
    );
  });

  it("transfer(id, true) forwards play=true", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.transfer("dev-1", true);
    expect(http.put).toHaveBeenCalledWith(
      "/v1/me/player",
      { device_ids: ["dev-1"], play: true },
      AUTH,
    );
  });

  it("play() PUTs /v1/me/player/play?device_id= with the uris body", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.play("dev-1", "spotify:track:abc");
    expect(http.put).toHaveBeenCalledWith(
      "/v1/me/player/play",
      { uris: ["spotify:track:abc"] },
      { headers: { Authorization: "Bearer tok123" }, params: { device_id: "dev-1" } },
    );
  });

  it("pause() PUTs /v1/me/player/pause (no params) with no body", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.pause();
    expect(http.put).toHaveBeenCalledWith("/v1/me/player/pause", undefined, {
      headers: { Authorization: "Bearer tok123" },
      params: undefined,
    });
  });

  it("pause(id) forwards device_id param", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.pause("dev-1");
    expect(http.put).toHaveBeenCalledWith("/v1/me/player/pause", undefined, {
      headers: { Authorization: "Bearer tok123" },
      params: { device_id: "dev-1" },
    });
  });

  it("resume() PUTs /v1/me/player/play with no uris body (resume)", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.resume();
    expect(http.put).toHaveBeenCalledWith("/v1/me/player/play", undefined, {
      headers: { Authorization: "Bearer tok123" },
      params: undefined,
    });
  });

  it("seek() PUTs /v1/me/player/seek?position_ms=", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.seek(42000);
    expect(http.put).toHaveBeenCalledWith("/v1/me/player/seek", undefined, {
      headers: { Authorization: "Bearer tok123" },
      params: { position_ms: 42000 },
    });
  });

  it("seek(ms, id) adds device_id param", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.seek(1000, "dev-1");
    expect(http.put).toHaveBeenCalledWith("/v1/me/player/seek", undefined, {
      headers: { Authorization: "Bearer tok123" },
      params: { position_ms: 1000, device_id: "dev-1" },
    });
  });

  it("mutating calls no-op (no http.put) when unauthorized", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(vi.fn().mockResolvedValue(null), { http });
    await api.transfer("dev-1");
    await api.play("dev-1", "spotify:track:x");
    await api.pause();
    expect(http.put).not.toHaveBeenCalled();
  });
});

describe("SpotifyConnectApi.getPlaybackState", () => {
  it("GETs /v1/me/player and maps is_playing/progress/item", async () => {
    const http = makeHttp({
      get: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          is_playing: true,
          progress_ms: 12345,
          item: { uri: "spotify:track:abc", duration_ms: 200000 },
        },
      }),
    });
    const api = new SpotifyConnectApi(token(), { http });
    const state = await api.getPlaybackState();
    expect(http.get).toHaveBeenCalledWith("/v1/me/player", AUTH);
    expect(state).toEqual({
      isPlaying: true,
      progressMs: 12345,
      trackUri: "spotify:track:abc",
      durationMs: 200000,
    });
  });

  it("returns null on 204 (no active device)", async () => {
    const http = makeHttp({ get: vi.fn().mockResolvedValue({ status: 204, data: "" }) });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.getPlaybackState()).resolves.toBeNull();
  });

  it("returns null when item is missing / trackUri null", async () => {
    const http = makeHttp({
      get: vi.fn().mockResolvedValue({ status: 200, data: { is_playing: false, progress_ms: 0, item: null } }),
    });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.getPlaybackState()).resolves.toEqual({
      isPlaying: false,
      progressMs: 0,
      trackUri: null,
      durationMs: 0,
    });
  });

  it("returns null on rejection (e.g. 401) instead of throwing", async () => {
    const http = makeHttp({ get: vi.fn().mockRejectedValue(new Error("boom")) });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.getPlaybackState()).resolves.toBeNull();
  });
});
```

- [ ] **Run the test — expect failure** (module not found / class undefined):
  - `npx vitest run src/music/spotify/connect-api.test.ts`
  - Expected: FAIL — `Failed to resolve import "./connect-api.js"` (implementation does not exist yet). This confirms the tests execute and are red before implementation.

- [ ] **Implement** `src/music/spotify/connect-api.ts` to make the tests pass. Mirrors the injected-axios + `getToken` conventions of `webapi.ts`/`go-librespot-api.ts`; read-only calls (`getDevices`, `getPlaybackState`) swallow errors and return `[]`/`null`, mutating calls no-op when unauthorized:

```ts
import axios, { type AxiosInstance } from "axios";

const API_BASE = "https://api.spotify.com";

export interface SpotifyDevice {
  id: string;
  name: string;
  is_active: boolean;
}

export interface PlaybackState {
  isPlaying: boolean;
  progressMs: number;
  trackUri: string | null;
  durationMs: number;
}

/**
 * Spotify Web API "Connect" remote-control client. Wraps an axios instance and
 * attaches a live user Bearer token from getToken() to every request. Read-only
 * calls degrade to []/null on error; mutating calls no-op when unauthorized.
 */
export class SpotifyConnectApi {
  private getToken: () => Promise<string | null>;
  private http: AxiosInstance;

  constructor(getToken: () => Promise<string | null>, deps?: { http?: AxiosInstance }) {
    this.getToken = getToken;
    this.http = deps?.http ?? axios.create({ baseURL: API_BASE, timeout: 15_000 });
  }

  /** Bearer auth headers, or null when no valid user token is available. */
  private async authHeaders(): Promise<{ Authorization: string } | null> {
    const token = await this.getToken();
    if (!token) return null;
    return { Authorization: `Bearer ${token}` };
  }

  async getDevices(): Promise<SpotifyDevice[]> {
    const headers = await this.authHeaders();
    if (!headers) return [];
    try {
      const { data } = await this.http.get("/v1/me/player/devices", { headers });
      const list = Array.isArray(data?.devices) ? data.devices : [];
      return list.map((d: any) => ({
        id: d?.id ?? "",
        name: d?.name ?? "",
        is_active: Boolean(d?.is_active),
      }));
    } catch {
      return [];
    }
  }

  async findDeviceByName(name: string): Promise<string | null> {
    const devices = await this.getDevices();
    const match = devices.find((d) => d.name === name);
    return match ? match.id : null;
  }

  async transfer(deviceId: string, play = false): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    await this.http.put("/v1/me/player", { device_ids: [deviceId], play }, { headers });
  }

  async play(deviceId: string, trackUri: string): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    await this.http.put(
      "/v1/me/player/play",
      { uris: [trackUri] },
      { headers, params: { device_id: deviceId } },
    );
  }

  async pause(deviceId?: string): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    await this.http.put("/v1/me/player/pause", undefined, {
      headers,
      params: deviceId ? { device_id: deviceId } : undefined,
    });
  }

  async resume(deviceId?: string): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    await this.http.put("/v1/me/player/play", undefined, {
      headers,
      params: deviceId ? { device_id: deviceId } : undefined,
    });
  }

  async seek(ms: number, deviceId?: string): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    const params: Record<string, unknown> = { position_ms: ms };
    if (deviceId) params.device_id = deviceId;
    await this.http.put("/v1/me/player/seek", undefined, { headers, params });
  }

  async getPlaybackState(): Promise<PlaybackState | null> {
    const headers = await this.authHeaders();
    if (!headers) return null;
    try {
      const res = await this.http.get("/v1/me/player", { headers });
      // 204 = no active device / playback; body is empty.
      if (res.status === 204 || !res.data) return null;
      const d = res.data;
      return {
        isPlaying: Boolean(d.is_playing),
        progressMs: Number(d.progress_ms ?? 0),
        trackUri: d.item?.uri ?? null,
        durationMs: Number(d.item?.duration_ms ?? 0),
      };
    } catch {
      return null;
    }
  }
}
```

- [ ] **Run the test — expect pass:**
  - `npx vitest run src/music/spotify/connect-api.test.ts`
  - Expected: PASS — all describe blocks green (`getDevices`, `findDeviceByName`, mutating calls, `getPlaybackState`), ~16 tests passing, 0 failing.

- [ ] **Typecheck the whole project (no emit):**
  - `npx tsc --noEmit`
  - Expected: exits 0, no errors. Confirms the new `SpotifyDevice`/`PlaybackState`/`SpotifyConnectApi` exports and the ESM `.js` import in the test compile cleanly.

- [ ] **Commit:**
  - `git add src/music/spotify/connect-api.ts src/music/spotify/connect-api.test.ts`
  - `git commit -m "$(cat <<'EOF'
feat(spotify): add SpotifyConnectApi Web API Connect control client

Wraps an injected axios instance with a live user Bearer token from
getToken(): getDevices/findDeviceByName, transfer/play/pause/resume/seek,
and getPlaybackState (null on 204). Read-only calls degrade gracefully;
mutating calls no-op when unauthorized. Fully unit-tested with a mocked
AxiosInstance (no network) — Windows-targeted, not e2e-testable (no Premium).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"`

**Notes / gotchas:**
- Source files are `.ts` in this repo but imports use the ESM `.js` specifier (`./connect-api.js`) — match `go-librespot-api.test.ts` exactly.
- Graceful error handling is verified by the "401 rejection → []/null" and "unauthorized → no http call" tests, covering the map's 401 (token) / 404 (no device) / 204 (no active device) cases without throwing.
- `getPlaybackState` returns `null` on HTTP 204 (no active device) — the poll loop in Task 5 relies on this exact contract for track-end detection.

---

### Task 4: RustLibrespotBackend

**Files:**
- CREATE `src/music/spotify/rust-librespot.ts`
- CREATE `src/music/spotify/rust-librespot.test.ts`

**Interfaces:**

_Consumes:_
```ts
// ./backend.js (Stage-2, verbatim)
interface SpotifyAudioBackend {
  start(): Promise<void>; stop(): void; isReady(): boolean;
  playTrack(uri: string): Promise<void>;
  pause(): Promise<void>; resume(): Promise<void>; seek(ms: number): Promise<void>;
  getPcmStream(): import("node:stream").Readable; getPositionMs(): number;
  on(event: "trackEnded", cb: (e: SpotifyTrackEndedEvent) => void): void;
  on(event: "metadata", cb: (m: SpotifyNowPlaying) => void): void;
  on(event: "ready" | "error", cb: (arg?: unknown) => void): void;
}
interface SpotifyTrackEndedEvent { uri: string; reason: "ended" | "stopped" | "error"; }
interface SpotifyNowPlaying { uri: string; name: string; artist: string; album: string; coverUrl: string; durationMs: number; }

// ./binary.js (Task 1)
function findLibrespot(): string;

// ./spotify-oauth.js (Task 2)
class SpotifyOAuth { getAccessToken(): Promise<string | null>; isAuthorized(): boolean; /* ... */ }

// ./connect-api.js (Task 3)
interface SpotifyDevice { id: string; name: string; is_active: boolean; }
interface PlaybackState { isPlaying: boolean; progressMs: number; trackUri: string | null; durationMs: number; }
class SpotifyConnectApi {
  getDevices(): Promise<SpotifyDevice[]>;
  findDeviceByName(name: string): Promise<string | null>;
  transfer(deviceId: string, play?: boolean): Promise<void>;
  play(deviceId: string, trackUri: string): Promise<void>;
  pause(deviceId?: string): Promise<void>;
  resume(deviceId?: string): Promise<void>;
  seek(ms: number, deviceId?: string): Promise<void>;
  getPlaybackState(): Promise<PlaybackState | null>;
}

// ../../audio/player.js (Stage-2)
function getFfmpegCommand(): string;
```

_Produces:_
```ts
export interface RustLibrespotBackendOptions {
  deviceName: string; bitrate: number; cacheDir: string;
  oauth: SpotifyOAuth; connect?: SpotifyConnectApi;
  logger: import("pino").Logger; deps?: RustLibrespotBackendDeps;
}
export interface RustLibrespotBackendDeps {
  spawn?: typeof import("node:child_process").spawn;
  mkdirSync?: typeof import("node:fs").mkdirSync;
  findBinary?: () => string;
  ffmpegCommand?: string;             // C1: pinned in tests, getFfmpegCommand() in prod
  sleep?: (ms: number) => Promise<void>;
  readyPollIntervalMs?: number; readyTimeoutMs?: number; statePollIntervalMs?: number;
}
export class RustLibrespotBackend extends EventEmitter implements SpotifyAudioBackend { /* full interface */ }
```

---

#### Steps

- [ ] **1. Write the failing test file** `src/music/spotify/rust-librespot.test.ts` (mirrors `go-librespot.test.ts`; injects `child_process`/`connect`/`oauth`/`ffmpegCommand`; NO real binary, NO network — `SpotifyConnectApi`/`SpotifyOAuth` are stubbed plain objects):

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { RustLibrespotBackend } from "./rust-librespot.js";

const log = pino({ level: "silent" });

/** ChildProcess stand-in with real Readable/Writable pipes so stdout->stdin piping works. */
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function makeConnect() {
  return {
    getDevices: vi.fn(async () => [{ id: "dev1", name: "Test Bot", is_active: false }]),
    findDeviceByName: vi.fn(async () => "dev1"),
    transfer: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    getPlaybackState: vi.fn(async () => null as any),
  };
}

function makeOAuth() {
  return {
    getAccessToken: vi.fn(async () => "tok-123" as string | null),
    isAuthorized: () => true,
  };
}

function makeHarness(over: { connect?: any; oauth?: any } = {}) {
  const calls: string[] = [];
  const librespotChild = makeFakeChild();
  const ffmpegChild = makeFakeChild();

  const spawn = vi.fn((cmd: string, ..._rest: any[]) => {
    const isLibrespot = cmd.includes("librespot");
    calls.push(`spawn:${isLibrespot ? "librespot" : cmd}`);
    return isLibrespot ? librespotChild : ffmpegChild;
  });
  const mkdirSync = vi.fn();
  const connect = over.connect ?? makeConnect();
  const oauth = over.oauth ?? makeOAuth();

  const backend = new RustLibrespotBackend({
    deviceName: "Test Bot",
    bitrate: 320,
    cacheDir: "/tmp/cache",
    oauth: oauth as any,
    connect: connect as any,
    logger: log,
    deps: {
      spawn: spawn as any,
      mkdirSync: mkdirSync as any,
      findBinary: () => "/bin/librespot",
      // C1: pin ffmpeg so arg-array assertions stay stable while prod uses getFfmpegCommand().
      ffmpegCommand: "ffmpeg",
      sleep: async () => {},
      readyPollIntervalMs: 1,
      readyTimeoutMs: 100,
      // huge so the background setInterval never fires; tests drive pollState() directly.
      statePollIntervalMs: 10_000_000,
    },
  });

  return { backend, calls, spawn, mkdirSync, connect, oauth, librespotChild, ffmpegChild };
}

describe("RustLibrespotBackend.start", () => {
  it("spawns librespot with the pipe/stdout arg set and the OAuth access token", async () => {
    const h = makeHarness();
    await h.backend.start();
    expect(h.spawn).toHaveBeenCalledWith(
      "/bin/librespot",
      [
        "--name", "Test Bot",
        "--backend", "pipe",
        "--bitrate", "320",
        "--format", "S16",
        "--cache", "/tmp/cache",
        "--device-type", "speaker",
        "--access-token", "tok-123",
      ],
      expect.anything(),
    );
    // NO --device (=> stdout) and NO --passthrough (=> decoded PCM, not Ogg).
    const args = h.spawn.mock.calls.find((c) => String(c[0]).includes("librespot"))![1] as string[];
    expect(args).not.toContain("--device");
    expect(args).not.toContain("--passthrough");
    h.backend.stop();
  });

  it("spawns ffmpeg (reader) before librespot (writer) with the exact 44100->48000 s16le args", async () => {
    const h = makeHarness();
    await h.backend.start();
    const ffmpegArgs = h.spawn.mock.calls.find((c) => c[0] === "ffmpeg")![1] as string[];
    expect(ffmpegArgs).toEqual([
      "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "pipe:0",
      "-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "pipe:1",
    ]);
    const ffmpegIdx = h.calls.indexOf("spawn:ffmpeg");
    const librespotIdx = h.calls.indexOf("spawn:librespot");
    expect(ffmpegIdx).toBeGreaterThanOrEqual(0);
    expect(librespotIdx).toBeGreaterThan(ffmpegIdx);
    h.backend.stop();
  });

  it("getPcmStream() returns the ffmpeg stdout Readable", async () => {
    const h = makeHarness();
    await h.backend.start();
    expect(h.backend.getPcmStream()).toBe(h.ffmpegChild.stdout);
    h.backend.stop();
  });

  it("emits 'ready' and reports isReady() true once our device appears in getDevices()", async () => {
    const h = makeHarness();
    const ready = vi.fn();
    h.backend.on("ready", ready);
    await h.backend.start();
    expect(h.connect.getDevices).toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(h.backend.isReady()).toBe(true);
    h.backend.stop();
  });

  it("keeps polling getDevices() until the device name appears", async () => {
    const h = makeHarness();
    h.connect.getDevices
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "other", name: "Someone else", is_active: true }])
      .mockResolvedValue([{ id: "dev1", name: "Test Bot", is_active: false }]);
    await h.backend.start();
    expect(h.connect.getDevices).toHaveBeenCalledTimes(3);
    expect(h.backend.isReady()).toBe(true);
    h.backend.stop();
  });

  it("throws (and does not spawn) when the OAuth token is null", async () => {
    const oauth = makeOAuth();
    oauth.getAccessToken.mockResolvedValue(null);
    const h = makeHarness({ oauth });
    await expect(h.backend.start()).rejects.toThrow(/authorized|token/i);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe("RustLibrespotBackend transport delegation (Connect API)", () => {
  it("playTrack resolves the device then transfer(false) then play(uri)", async () => {
    const h = makeHarness();
    await h.backend.playTrack("spotify:track:go");
    expect(h.connect.findDeviceByName).toHaveBeenCalledWith("Test Bot");
    expect(h.connect.transfer).toHaveBeenCalledWith("dev1", false);
    expect(h.connect.play).toHaveBeenCalledWith("dev1", "spotify:track:go");
    // ordering: transfer before play
    expect(h.connect.transfer.mock.invocationCallOrder[0])
      .toBeLessThan(h.connect.play.mock.invocationCallOrder[0]);
  });

  it("playTrack throws when the device cannot be found", async () => {
    const h = makeHarness();
    h.connect.findDeviceByName.mockResolvedValue(null);
    await expect(h.backend.playTrack("spotify:track:x")).rejects.toThrow(/device/i);
  });

  it("pause/resume/seek delegate to the Connect API and seek updates position", async () => {
    const h = makeHarness();
    await h.backend.pause();
    await h.backend.resume();
    await h.backend.seek(5000);
    expect(h.connect.pause).toHaveBeenCalled();
    expect(h.connect.resume).toHaveBeenCalled();
    expect(h.connect.seek).toHaveBeenCalledWith(5000);
    expect(h.backend.getPositionMs()).toBe(5000);
  });
});

describe("RustLibrespotBackend track-end poll loop", () => {
  it("emits trackEnded when progress reaches the end-of-track window", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    const meta = vi.fn();
    h.backend.on("trackEnded", ended);
    h.backend.on("metadata", meta);
    h.connect.getPlaybackState
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 1000, trackUri: "spotify:track:A", durationMs: 200000 })
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 199000, trackUri: "spotify:track:A", durationMs: 200000 });
    await (h.backend as any).pollState();
    expect(meta).toHaveBeenCalledWith(expect.objectContaining({ uri: "spotify:track:A", durationMs: 200000 }));
    expect(h.backend.getPositionMs()).toBe(1000);
    expect(ended).not.toHaveBeenCalled();
    await (h.backend as any).pollState();
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:A", reason: "ended" });
  });

  it("emits trackEnded once when playback stops (!isPlaying) after having played", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.connect.getPlaybackState
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000 })
      .mockResolvedValueOnce({ isPlaying: false, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000 })
      .mockResolvedValue({ isPlaying: false, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000 });
    await (h.backend as any).pollState();
    await (h.backend as any).pollState();
    await (h.backend as any).pollState(); // idempotent: no second emit for same track
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:A", reason: "ended" });
  });

  it("emits trackEnded when the track uri transitions to null after playing", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.connect.getPlaybackState
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 1000, trackUri: "spotify:track:A", durationMs: 200000 })
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 0, trackUri: null, durationMs: 0 });
    await (h.backend as any).pollState();
    await (h.backend as any).pollState();
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:A", reason: "ended" });
  });

  it("ignores a null playback state (no active device) without emitting", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.connect.getPlaybackState.mockResolvedValue(null);
    await (h.backend as any).pollState();
    expect(ended).not.toHaveBeenCalled();
  });
});

describe("RustLibrespotBackend.stop", () => {
  it("kills librespot + ffmpeg, clears ready, and is idempotent", async () => {
    const h = makeHarness();
    await h.backend.start();
    h.backend.stop();
    h.backend.stop(); // second call must not throw
    expect(h.librespotChild.kill).toHaveBeenCalled();
    expect(h.ffmpegChild.kill).toHaveBeenCalled();
    expect(h.backend.isReady()).toBe(false);
  });
});

describe("RustLibrespotBackend.start failure cleanup", () => {
  it("tears down librespot + ffmpeg when the device never appears", async () => {
    const h = makeHarness();
    h.connect.getDevices.mockResolvedValue([]); // device never shows up -> waitForDevice times out
    await expect(h.backend.start()).rejects.toThrow(/did not appear/i);
    expect(h.librespotChild.kill).toHaveBeenCalled();
    expect(h.ffmpegChild.kill).toHaveBeenCalled();
    expect(h.backend.isReady()).toBe(false);
  });
});

describe("RustLibrespotBackend child-process error handling", () => {
  it("swallows+logs a child 'error' when no backend 'error' listener is attached", async () => {
    const h = makeHarness();
    await h.backend.start();
    expect(h.backend.listenerCount("error")).toBe(0);
    expect(() => h.librespotChild.emit("error", new Error("boom"))).not.toThrow();
    expect(() => h.ffmpegChild.emit("error", new Error("boom"))).not.toThrow();
    h.backend.stop();
  });

  it("re-emits a child 'error' to an attached backend 'error' listener", async () => {
    const h = makeHarness();
    await h.backend.start();
    const onErr = vi.fn();
    h.backend.on("error", onErr);
    const err = new Error("ffmpeg boom");
    h.ffmpegChild.emit("error", err);
    expect(onErr).toHaveBeenCalledWith(err);
    h.backend.stop();
  });
});
```

- [ ] **2. Verify RED** — the test must fail because the module does not exist yet:

```
npx vitest run src/music/spotify/rust-librespot.test.ts
```
Expected: fails to import / all suites error (`Cannot find module './rust-librespot.js'`).

- [ ] **3. Implement** `src/music/spotify/rust-librespot.ts` (mirrors `go-librespot.ts`: C1 ffmpeg resolution, start-cleanup try/catch, `emitError` listener guard). Note: stdout-pipe transport means NO FIFO/mkfifo and NO config.yml — control is entirely via the injected `SpotifyConnectApi`:

```ts
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { spawn as realSpawn } from "node:child_process";
import { mkdirSync as realMkdirSync } from "node:fs";
import type { Logger } from "pino";
import type {
  SpotifyAudioBackend,
  SpotifyTrackEndedEvent,
  SpotifyNowPlaying,
} from "./backend.js";
import { findLibrespot } from "./binary.js";
import { SpotifyConnectApi } from "./connect-api.js";
import type { PlaybackState, SpotifyDevice } from "./connect-api.js";
import type { SpotifyOAuth } from "./spotify-oauth.js";
import { getFfmpegCommand } from "../../audio/player.js";

export interface RustLibrespotBackendOptions {
  deviceName: string;
  bitrate: number;
  cacheDir: string;
  oauth: SpotifyOAuth;
  connect?: SpotifyConnectApi;
  logger: Logger;
  deps?: RustLibrespotBackendDeps;
}

/** Injectable seams so the whole lifecycle is testable without a real binary/network. */
export interface RustLibrespotBackendDeps {
  spawn?: typeof realSpawn;
  mkdirSync?: typeof realMkdirSync;
  findBinary?: () => string;
  /**
   * C1: override the ffmpeg command. Production resolves it via
   * getFfmpegCommand() (bundled ffmpeg-static fallback when `ffmpeg` isn't on
   * PATH); tests pin it to "ffmpeg" for stable arg assertions.
   */
  ffmpegCommand?: string;
  sleep?: (ms: number) => Promise<void>;
  readyPollIntervalMs?: number;
  readyTimeoutMs?: number;
  statePollIntervalMs?: number;
}

const DEFAULT_READY_POLL_MS = 500;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_STATE_POLL_MS = 2_000;
/** How close to the end (ms) counts as "track finished" when polling player state. */
const END_OF_TRACK_WINDOW_MS = 1_500;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RustLibrespotBackend extends EventEmitter implements SpotifyAudioBackend {
  private readonly opts: RustLibrespotBackendOptions;
  private readonly log: Logger;
  private readonly deps: RustLibrespotBackendDeps;
  private readonly oauth: SpotifyOAuth;
  private readonly connect: SpotifyConnectApi;

  private proc: ChildProcess | null = null;
  private ffmpeg: ChildProcess | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ready = false;
  private positionMs = 0;

  // track-end poll state machine
  private currentUri: string | null = null;
  private hasPlayed = false;
  private endedForCurrent = false;

  constructor(o: RustLibrespotBackendOptions) {
    super();
    this.opts = o;
    this.log = o.logger;
    this.deps = o.deps ?? {};
    this.oauth = o.oauth;
    // The Connect API shares the backend's OAuth token source. Reuse the
    // injected instance in tests; otherwise build one over oauth.getAccessToken().
    this.connect = o.connect ?? new SpotifyConnectApi(() => this.oauth.getAccessToken());
  }

  async start(): Promise<void> {
    const spawn = this.deps.spawn ?? realSpawn;
    const mkdirSync = this.deps.mkdirSync ?? realMkdirSync;
    const findBinary = this.deps.findBinary ?? findLibrespot;
    // C1: resolve ffmpeg via getFfmpegCommand() unless injected for tests.
    const ffmpegCommand = this.deps.ffmpegCommand ?? getFfmpegCommand();

    // A valid USER control token is required before we spawn anything.
    const token = await this.oauth.getAccessToken();
    if (!token) {
      throw new Error("Spotify not authorized (no access token) — sign in first");
    }

    mkdirSync(this.opts.cacheDir, { recursive: true });

    // Everything past here spawns children / opens the state poll. On any
    // failure (e.g. the device never appears), tear it all down via stop().
    try {
      // 1. Spawn ffmpeg FIRST (the reader) so its stdin pipe is ready before
      //    librespot starts pushing raw 44.1k s16le PCM into it.
      this.ffmpeg = spawn(
        ffmpegCommand,
        [
          "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "pipe:0",
          "-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      this.ffmpeg.stderr?.on("data", (b: Buffer) =>
        this.log.debug({ ffmpeg: b.toString().trim() }, "ffmpeg"),
      );
      this.ffmpeg.on("error", (err) => this.emitError(err));

      // 2. Spawn librespot: --backend pipe with NO --device => raw s16le/44100/2
      //    on stdout, NO --passthrough (that would emit raw Ogg). --access-token
      //    authenticates it as a Connect device controllable via the Web API.
      const bin = findBinary();
      this.proc = spawn(
        bin,
        [
          "--name", this.opts.deviceName,
          "--backend", "pipe",
          "--bitrate", String(this.opts.bitrate),
          "--format", "S16",
          "--cache", this.opts.cacheDir,
          "--device-type", "speaker",
          "--access-token", token,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      // stdout carries PCM — pipe it, never attach a data listener that consumes it.
      if (this.proc.stdout && this.ffmpeg.stdin) {
        this.proc.stdout.pipe(this.ffmpeg.stdin);
      }
      this.proc.stderr?.on("data", (b: Buffer) =>
        this.log.info({ librespot: b.toString().trim() }, "librespot"),
      );
      this.proc.on("error", (err) => this.emitError(err));
      this.proc.on("exit", (code, signal) => {
        this.ready = false;
        this.log.warn({ code, signal }, "librespot exited");
      });

      // 3. Poll the Connect device list until our device registers.
      await this.waitForDevice();

      // 4. Begin the player-state poll loop (track-end / position / metadata).
      this.startPollLoop();

      this.ready = true;
      this.emit("ready");
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  /**
   * Re-emit a child "error" only when a consumer is listening; Node throws on an
   * unhandled "error" event, so with no listener we log via the injected logger.
   */
  private emitError(err: unknown): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    } else {
      this.log.error({ err }, "rust-librespot backend error (no listener)");
    }
  }

  private async waitForDevice(): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    const interval = this.deps.readyPollIntervalMs ?? DEFAULT_READY_POLL_MS;
    const timeout = this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let devices: SpotifyDevice[] = [];
      try {
        devices = await this.connect.getDevices();
      } catch (err) {
        this.log.debug({ err }, "getDevices failed during readiness poll");
      }
      if (devices.some((d) => d.name === this.opts.deviceName)) return;
      await sleep(interval);
    }
    throw new Error(`librespot device "${this.opts.deviceName}" did not appear within timeout`);
  }

  private startPollLoop(): void {
    const interval = this.deps.statePollIntervalMs ?? DEFAULT_STATE_POLL_MS;
    this.pollTimer = setInterval(() => {
      void this.pollState();
    }, interval);
    // Don't keep the event loop / test process alive on account of the poll timer.
    this.pollTimer.unref?.();
  }

  /** One player-state poll iteration: updates position/metadata and detects track end. */
  private async pollState(): Promise<void> {
    let state: PlaybackState | null;
    try {
      state = await this.connect.getPlaybackState();
    } catch (err) {
      this.log.debug({ err }, "getPlaybackState failed");
      return;
    }
    if (!state) return; // 204 / no active device

    this.positionMs = state.progressMs;

    // Track change -> reset the end-detection state and surface best-effort metadata.
    if (state.trackUri && state.trackUri !== this.currentUri) {
      this.currentUri = state.trackUri;
      this.hasPlayed = false;
      this.endedForCurrent = false;
      const np: SpotifyNowPlaying = {
        uri: state.trackUri,
        name: "",
        artist: "",
        album: "",
        coverUrl: "",
        durationMs: state.durationMs,
      };
      this.emit("metadata", np);
    }

    if (state.isPlaying) this.hasPlayed = true;
    if (!this.currentUri || this.endedForCurrent) return;

    const finishedByProgress =
      state.durationMs > 0 && state.progressMs >= state.durationMs - END_OF_TRACK_WINDOW_MS;
    const finishedByStop = this.hasPlayed && !state.isPlaying;
    const finishedByNull = this.hasPlayed && state.trackUri === null;

    if (finishedByProgress || finishedByStop || finishedByNull) {
      this.endedForCurrent = true;
      const endedUri = this.currentUri;
      this.currentUri = null;
      const e: SpotifyTrackEndedEvent = { uri: endedUri, reason: "ended" };
      this.emit("trackEnded", e);
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async playTrack(uri: string): Promise<void> {
    const deviceId = await this.connect.findDeviceByName(this.opts.deviceName);
    if (!deviceId) throw new Error(`Connect device "${this.opts.deviceName}" not found`);
    await this.connect.transfer(deviceId, false);
    await this.connect.play(deviceId, uri);
  }

  async pause(): Promise<void> {
    await this.connect.pause();
  }

  async resume(): Promise<void> {
    await this.connect.resume();
  }

  async seek(ms: number): Promise<void> {
    await this.connect.seek(ms);
    this.positionMs = ms;
  }

  getPcmStream(): Readable {
    const out = this.ffmpeg?.stdout;
    if (!out) throw new Error("PCM stream unavailable (rust-librespot backend not started)");
    return out;
  }

  getPositionMs(): number {
    return this.positionMs;
  }

  stop(): void {
    this.ready = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    if (this.ffmpeg) {
      try {
        this.ffmpeg.kill();
      } catch {
        /* ignore */
      }
      this.ffmpeg = null;
    }
  }
}
```

- [ ] **4. Verify GREEN**:

```
npx vitest run src/music/spotify/rust-librespot.test.ts
```
Expected: all suites pass (start args/order/ready, transport delegation, three track-end transitions + null-state ignore, stop idempotency, start-failure cleanup, error-guard both branches).

- [ ] **5. Type-check the whole project**:

```
npx tsc --noEmit
```
Expected: exits 0, no errors. (If `./binary.js`, `./connect-api.js`, or `./spotify-oauth.js` are not yet implemented from Tasks 1-3, this fails on those imports — land this task after them.)

- [ ] **6. Commit**:

```
git add src/music/spotify/rust-librespot.ts src/music/spotify/rust-librespot.test.ts
git commit -m "$(cat <<'EOF'
feat(spotify): add RustLibrespotBackend (stdout-pipe -> ffmpeg, Connect-API control)

Implements the Stage-2 SpotifyAudioBackend over Rust librespot: spawns
librespot with --backend pipe (no --device => s16le/44100/2 on stdout, no
--passthrough), pipes stdout -> ffmpeg (44100->48000 s16le), waits for the
Connect device to register before emitting "ready", and controls playback
(transfer/play/pause/resume/seek) plus track-end/position/metadata via a
polled SpotifyConnectApi. child_process/connect/oauth/ffmpeg injected for
fully mocked, no-network unit tests (Windows-targeted; not e2e without Premium).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Notes / rationale:**
- **No FIFO/config.yml** (unlike `go-librespot.ts`): Rust librespot's pipe backend writes PCM straight to `stdout`, so transport is `librespot.stdout -> ffmpeg.stdin` and all control goes through the injected `SpotifyConnectApi` (Web API), not a local REST server.
- **ffmpeg args match the contract exactly** (`-i pipe:0 ... pipe:1`) — no `-hide_banner/-loglevel` prefix, since librespot stdout (not a FIFO path) is the input.
- **`pollState()` is a private method driven by `setInterval`** but tested directly (no fake timers) for deterministic transition assertions; the interval is `unref()`'d and cleared in `stop()`.
- **`stop()` is idempotent** and is also called from `start()`'s `catch` for start-failure cleanup, mirroring the go backend.
- **`emitError` listener guard** is identical to the go backend to avoid crashing Node on an unhandled `"error"`.
- This is Windows-targeted and **not e2e-testable** (no Premium account / no real binary) — all coverage is mocked/unit-level per the injected seams.

---

### Task 5: Backend selection in SpotifyController

Add `chooseBackend()` to `SpotifyController` so it honors `config.spotify.backend` (`"go-librespot" | "librespot" | "auto"`) against platform + binary availability, constructs a shared `SpotifyOAuth` + `SpotifyConnectApi` it hands to the Rust backend, gates `isAvailable()` on a selectable backend, and gates the Rust path's `ensureStarted()` on `oauth.isAuthorized()`. The go-librespot path and every existing Stage-2 controller test stay behavior-unchanged. Windows-targeted, unit-level only (no real binary/network; PKCE-adjacent deps injected).

**Files:**
- MODIFY `src/music/spotify/controller.ts`
- MODIFY `src/music/spotify/controller.test.ts`

**Interfaces:**

_Consumes (verbatim from prior tasks — do not redeclare):_
```ts
// ./binary.js
export function isGoLibrespotSupported(): boolean
export function findGoLibrespot(): string
export function isRustLibrespotSupported(): boolean          // Task 1 — true on all platforms
export function findLibrespot(): string                      // Task 1 — bin/librespot(.exe) then PATH
// ./spotify-oauth.js  (Task 2)
export interface OAuthTokens { accessToken: string; refreshToken: string; expiresAt: number; scope: string }
export interface OAuthTokenStore { load(): OAuthTokens | null; save(t: OAuthTokens): void; clear(): void }
export class SpotifyOAuth {
  constructor(o: { clientId?: string; redirectUri?: string; store: OAuthTokenStore; deps?: { http?: import("axios").AxiosInstance } })
  isAuthorized(): boolean
  getAccessToken(): Promise<string | null>
}
// ./connect-api.js  (Task 3)
export class SpotifyConnectApi {
  constructor(getToken: () => Promise<string | null>, deps?: { http?: import("axios").AxiosInstance })
}
// ./rust-librespot.js  (Task 4)
export interface RustLibrespotBackendOptions { deviceName: string; bitrate: number; cacheDir: string; oauth: SpotifyOAuth; connect?: SpotifyConnectApi; logger: import("pino").Logger; deps?: any }
export class RustLibrespotBackend implements SpotifyAudioBackend { constructor(o: RustLibrespotBackendOptions) }
// ./backend.js
export interface SpotifyAudioBackend { /* start/stop/isReady/playTrack/pause/resume/seek/getPcmStream/getPositionMs/on */ }
```

_Produces (new/changed public surface on `SpotifyController`):_
```ts
export type SpotifyBackendKind = "go-librespot" | "librespot";
export interface SpotifyControllerOptions {
  config: SpotifyConfig; workDir: string; configDir: string; logger: import("pino").Logger;
  apiPort?: number; callbackPort?: number;
  backendFactory?: () => SpotifyAudioBackend;   // test override (unchanged)
  oauth?: SpotifyOAuth;                          // NEW — injected in tests; default file-backed
  connect?: SpotifyConnectApi;                   // NEW — injected in tests; default wired to oauth
}
class SpotifyController {
  getOAuth(): SpotifyOAuth                        // NEW — shared with web router (Task 6) + Rust backend
  getConnect(): SpotifyConnectApi                 // NEW
  chooseBackend(): SpotifyBackendKind | null      // NEW
  isAvailable(): boolean                          // CHANGED: enabled && chooseBackend() !== null
  ensureStarted(): Promise<boolean>               // CHANGED: rust kind also requires oauth.isAuthorized()
}
```

---

- [ ] **Step 5.1 — Red: write the failing tests.** Update `src/music/spotify/controller.test.ts`. Extend the hoisted `bin` mock + `vi.mock("./binary.js")` to expose the Rust binary probes, add Rust defaults to `beforeEach`, teach `makeCtrl` to inject `oauth`, add a `fakeOAuth` helper, then append the two new `describe` blocks. All existing lines/assertions stay as-is.

  Replace the existing hoisted-`bin` + `vi.mock("./binary.js")` block (top of file) with:
  ```ts
  // Controllable, hoisted so the vi.mock factory can close over it.
  // go-* keys keep their Stage-2 names (`supported`/`path`) so existing tests are
  // untouched; rust* keys drive the new librespot selection paths.
  const bin = vi.hoisted(() => ({
    supported: true,
    path: "",
    rustSupported: true,
    rustPath: "",
  }));
  vi.mock("./binary.js", () => ({
    isGoLibrespotSupported: () => bin.supported,
    findGoLibrespot: () => bin.path,
    resetGoLibrespotBinaryCache: () => {},
    checkGoLibrespotAvailable: async () => bin.supported && !!bin.path,
    isRustLibrespotSupported: () => bin.rustSupported,
    findLibrespot: () => bin.rustPath,
    resetLibrespotBinaryCache: () => {},
    checkLibrespotAvailable: async () => bin.rustSupported && !!bin.rustPath,
  }));
  ```

  Extend the existing `beforeEach` so the Rust binary defaults to "supported but absent" — this keeps every Stage-2 `auto` test selecting go-librespot exactly as before:
  ```ts
  beforeEach(() => {
    bin.supported = true;
    bin.path = existingBin;
    bin.rustSupported = true;
    bin.rustPath = missingBin;
  });
  ```

  Teach `makeCtrl` to forward an injected `oauth` (default: none → controller builds its own file-backed one, which is inert for the go path):
  ```ts
  function makeCtrl(over: {
    config?: Partial<SpotifyConfig>;
    backendFactory?: () => SpotifyAudioBackend;
    oauth?: import("./spotify-oauth.js").SpotifyOAuth;
  } = {}) {
    const be = new FakeBackend();
    const ctrl = new SpotifyController({
      config: cfg(over.config),
      workDir: "/tmp/work",
      configDir: "/tmp/cfg",
      logger: silentLogger,
      backendFactory: over.backendFactory ?? (() => be),
      oauth: over.oauth,
    });
    return { ctrl, be };
  }
  ```

  Add a `fakeOAuth` helper next to `makeCtrl` (typed enough for the controller; no network):
  ```ts
  import type { SpotifyOAuth } from "./spotify-oauth.js";
  function fakeOAuth(
    authorized: boolean,
    hooks: { onIsAuthorized?: () => void } = {},
  ): SpotifyOAuth {
    return {
      isAuthorized: () => {
        hooks.onIsAuthorized?.();
        return authorized;
      },
      getAccessToken: async () => (authorized ? "tok" : null),
      getClientId: () => "cid",
      getRedirectUri: () => "http://127.0.0.1:5588/login",
      buildAuthorizeUrl: () => ({ url: "https://accounts.spotify.com/authorize", state: "s" }),
      handleCallback: async () => true,
    } as unknown as SpotifyOAuth;
  }
  ```

  Append the two new `describe` blocks at the end of the file:
  ```ts
  describe("SpotifyController.chooseBackend (platform x config matrix)", () => {
    function pick(
      backend: SpotifyConfig["backend"],
      opts: { go: boolean; goSupported?: boolean; rust: boolean; rustSupported?: boolean },
    ) {
      bin.supported = opts.goSupported ?? true;
      bin.path = opts.go ? existingBin : missingBin;
      bin.rustSupported = opts.rustSupported ?? true;
      bin.rustPath = opts.rust ? existingBin : missingBin;
      const { ctrl } = makeCtrl({ config: { backend } });
      return ctrl.chooseBackend();
    }

    it("auto: prefers go-librespot when linux + go binary present", () => {
      expect(pick("auto", { go: true, rust: true })).toBe("go-librespot");
    });
    it("auto: falls back to librespot when go unsupported (e.g. Windows) but librespot present", () => {
      expect(pick("auto", { go: true, goSupported: false, rust: true })).toBe("librespot");
    });
    it("auto: falls back to librespot when go binary is absent", () => {
      expect(pick("auto", { go: false, rust: true })).toBe("librespot");
    });
    it("auto: null when neither backend is usable", () => {
      expect(pick("auto", { go: false, goSupported: false, rust: false })).toBeNull();
    });
    it("go-librespot: selected when supported + present", () => {
      expect(pick("go-librespot", { go: true, rust: true })).toBe("go-librespot");
    });
    it("go-librespot: null when unsupported, even if librespot is present", () => {
      expect(pick("go-librespot", { go: true, goSupported: false, rust: true })).toBeNull();
    });
    it("librespot: selected when the librespot binary is present", () => {
      expect(pick("librespot", { go: true, rust: true })).toBe("librespot");
    });
    it("librespot: null when the librespot binary is absent, even if go is present", () => {
      expect(pick("librespot", { go: true, rust: false })).toBeNull();
    });
  });

  describe("SpotifyController Rust-backend auth gate", () => {
    it("isAvailable is true for a present librespot binary regardless of auth", () => {
      bin.rustPath = existingBin;
      const { ctrl } = makeCtrl({
        config: { backend: "librespot" },
        oauth: fakeOAuth(false),
      });
      expect(ctrl.isAvailable()).toBe(true);
    });

    it("ensureStarted returns false (no backend built) when Rust chosen but unauthorized", async () => {
      bin.rustPath = existingBin;
      let built = 0;
      const { ctrl } = makeCtrl({
        config: { backend: "librespot" },
        oauth: fakeOAuth(false),
        backendFactory: () => {
          built++;
          return new FakeBackend();
        },
      });
      expect(await ctrl.ensureStarted()).toBe(false);
      expect(built).toBe(0);
    });

    it("ensureStarted starts the Rust backend once authorized", async () => {
      bin.rustPath = existingBin;
      const be = new FakeBackend();
      let built = 0;
      const { ctrl } = makeCtrl({
        config: { backend: "librespot" },
        oauth: fakeOAuth(true),
        backendFactory: () => {
          built++;
          return be;
        },
      });
      expect(await ctrl.ensureStarted()).toBe(true);
      expect(built).toBe(1);
      expect(be.startCalls).toBe(1);
    });

    it("go-librespot path never consults oauth.isAuthorized()", async () => {
      // auto + go present -> go-librespot; the auth gate must be skipped so a
      // throwing isAuthorized() is never reached.
      const oauth = fakeOAuth(false, {
        onIsAuthorized: () => {
          throw new Error("isAuthorized must not be called on the go path");
        },
      });
      const { ctrl } = makeCtrl({ config: { backend: "auto" }, oauth });
      expect(await ctrl.ensureStarted()).toBe(true);
    });

    it("exposes the shared oauth + connect instances", () => {
      const oauth = fakeOAuth(true);
      const { ctrl } = makeCtrl({ config: { backend: "auto" }, oauth });
      expect(ctrl.getOAuth()).toBe(oauth);
      expect(ctrl.getConnect()).toBeDefined();
    });
  });
  ```

- [ ] **Step 5.2 — Confirm Red.** Run:
  ```
  npx vitest run src/music/spotify/controller.test.ts
  ```
  Expected: the new `chooseBackend` and auth-gate specs FAIL (e.g. `ctrl.chooseBackend is not a function`, `getOAuth`/`getConnect` undefined, Rust unauthorized start returns `true`). Existing Stage-2 specs may also error on `ctrl` construction until 5.3 lands — that's expected Red.

- [ ] **Step 5.3 — Green: rewrite `src/music/spotify/controller.ts`.** Replace the whole file with the version below. It adds the Rust imports, a lazy/guarded `FileOAuthTokenStore`, owns `oauth`/`connect`, `chooseBackend()`, `buildBackend()`, the widened `isAvailable()`, and the Rust auth gate in `ensureStarted()`. `handleBackendError`, `playTrack`, `pause`, `resume`, `seek`, `getPcmStream`, and `stop` are carried over verbatim.
  ```ts
  import { EventEmitter } from "node:events";
  import {
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    rmSync,
  } from "node:fs";
  import { dirname, join } from "node:path";
  import type { Readable } from "node:stream";
  import type { Logger } from "pino";
  import type { SpotifyConfig } from "../../data/config.js";
  import type {
    SpotifyAudioBackend,
    SpotifyTrackEndedEvent,
    SpotifyNowPlaying,
  } from "./backend.js";
  import {
    isGoLibrespotSupported,
    findGoLibrespot,
    isRustLibrespotSupported,
    findLibrespot,
  } from "./binary.js";
  import { GoLibrespotBackend } from "./go-librespot.js";
  import { RustLibrespotBackend } from "./rust-librespot.js";
  import {
    SpotifyOAuth,
    type OAuthTokens,
    type OAuthTokenStore,
  } from "./spotify-oauth.js";
  import { SpotifyConnectApi } from "./connect-api.js";

  /** Which concrete backend the controller will run for this host + config. */
  export type SpotifyBackendKind = "go-librespot" | "librespot";

  /**
   * Minimal file-backed OAuth token store used when the caller does not inject a
   * SpotifyOAuth. Persists the rotating refresh-token JSON next to the bot config
   * (0600). All IO is lazy + guarded so construction never throws and a
   * missing/corrupt file simply reads as "unauthorized".
   */
  class FileOAuthTokenStore implements OAuthTokenStore {
    constructor(private readonly file: string) {}
    load(): OAuthTokens | null {
      try {
        if (!existsSync(this.file)) return null;
        return JSON.parse(readFileSync(this.file, "utf8")) as OAuthTokens;
      } catch {
        return null;
      }
    }
    save(t: OAuthTokens): void {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(t), { mode: 0o600 });
    }
    clear(): void {
      try {
        rmSync(this.file, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  export interface SpotifyControllerOptions {
    config: SpotifyConfig;
    workDir: string;
    configDir: string;
    logger: Logger;
    /** Per-bot go-librespot control-API port (distinct per bot to avoid binds). */
    apiPort?: number;
    /** Per-bot go-librespot OAuth callback port (distinct per bot). */
    callbackPort?: number;
    /** Injected for tests; when set it overrides the per-kind default builders. */
    backendFactory?: () => SpotifyAudioBackend;
    /** Injected for tests; defaults to a file-backed SpotifyOAuth in configDir. */
    oauth?: SpotifyOAuth;
    /** Injected for tests; defaults to a SpotifyConnectApi wired to oauth. */
    connect?: SpotifyConnectApi;
  }

  /**
   * Per-bot orchestrator for the Spotify sidecar. Selects a backend for this
   * host+config (chooseBackend), owns backend lifecycle, gates on availability
   * (config + platform + binary) plus — for the Rust librespot backend — OAuth
   * authorization, delegates transport, and re-emits "trackEnded"/"metadata" so
   * BotInstance can advance the queue exactly as for the ffmpeg path.
   *
   * Correction C3 (unchanged): this controller does NOT re-emit a raw "error"
   * event. It subscribes to the backend's "error", logs it, tears the backend
   * down, and marks itself not-ready so the next ensureStarted() relaunches a
   * fresh backend. getPcmStream() proxies the backend's SINGLE persistent stream.
   */
  export class SpotifyController extends EventEmitter {
    private readonly config: SpotifyConfig;
    private readonly workDir: string;
    private readonly configDir: string;
    private readonly logger: Logger;
    private readonly apiPort?: number;
    private readonly callbackPort?: number;
    private readonly injectedFactory?: () => SpotifyAudioBackend;
    private readonly oauth: SpotifyOAuth;
    private readonly connect: SpotifyConnectApi;

    private backend: SpotifyAudioBackend | null = null;
    private started = false;
    private startPromise: Promise<boolean> | null = null;

    constructor(o: SpotifyControllerOptions) {
      super();
      this.config = o.config;
      this.workDir = o.workDir;
      this.configDir = o.configDir;
      this.logger = o.logger;
      this.apiPort = o.apiPort;
      this.callbackPort = o.callbackPort;
      this.injectedFactory = o.backendFactory;
      // The controller OWNS a shared OAuth + Connect pair (Task 6 web router and
      // the Rust backend reuse these exact instances). Constructing the defaults
      // performs no IO/network — the file store loads lazily on first use.
      this.oauth =
        o.oauth ??
        new SpotifyOAuth({
          store: new FileOAuthTokenStore(
            join(this.configDir, "spotify-oauth.json"),
          ),
        });
      this.connect =
        o.connect ?? new SpotifyConnectApi(() => this.oauth.getAccessToken());
    }

    /** Shared OAuth client (web router + Rust backend reuse this instance). */
    getOAuth(): SpotifyOAuth {
      return this.oauth;
    }

    /** Shared Connect API client (Rust backend reuses this instance). */
    getConnect(): SpotifyConnectApi {
      return this.connect;
    }

    private goPresent(): boolean {
      return isGoLibrespotSupported() && existsSync(findGoLibrespot());
    }

    private rustPresent(): boolean {
      return isRustLibrespotSupported() && existsSync(findLibrespot());
    }

    /**
     * Resolve which backend to run for this platform + config, or null when none
     * is usable (caller falls back to the Stage-1 sentinel message):
     *   "go-librespot" -> GoLibrespot iff supported (linux) + binary present
     *   "librespot"    -> Rust iff librespot(.exe) present (all platforms)
     *   "auto"         -> GoLibrespot when (linux + go binary), else Rust when
     *                     librespot present, else null.
     */
    chooseBackend(): SpotifyBackendKind | null {
      switch (this.config.backend) {
        case "go-librespot":
          return this.goPresent() ? "go-librespot" : null;
        case "librespot":
          return this.rustPresent() ? "librespot" : null;
        case "auto":
        default:
          if (this.goPresent()) return "go-librespot";
          if (this.rustPresent()) return "librespot";
          return null;
      }
    }

    /** enabled in config AND a backend is selectable (platform + binary present). */
    isAvailable(): boolean {
      return this.config.enabled && this.chooseBackend() !== null;
    }

    /** Build the concrete backend for the chosen kind (or the injected fake). */
    private buildBackend(kind: SpotifyBackendKind): SpotifyAudioBackend {
      if (this.injectedFactory) return this.injectedFactory();
      if (kind === "librespot") {
        return new RustLibrespotBackend({
          deviceName: this.config.deviceName,
          bitrate: this.config.bitrate,
          cacheDir: join(this.workDir, "librespot-cache"),
          oauth: this.oauth,
          connect: this.connect,
          logger: this.logger,
        });
      }
      return new GoLibrespotBackend({
        deviceName: this.config.deviceName,
        bitrate: this.config.bitrate,
        workDir: this.workDir,
        configDir: this.configDir,
        apiPort: this.apiPort,
        callbackPort: this.callbackPort,
        logger: this.logger,
      });
    }

    /**
     * Idempotently start the selected backend. Returns false (without building a
     * backend) when unavailable, or — for the Rust backend — when OAuth is not
     * yet authorized, so callers show the login-needed / fallback message. A
     * failed start clears the cached promise so a later call can retry.
     */
    async ensureStarted(): Promise<boolean> {
      if (!this.isAvailable()) return false;
      const kind = this.chooseBackend();
      if (!kind) return false;
      // The Rust librespot device only appears in Spotify Connect once the user
      // has authorized OAuth; without it, do not spawn a dead sidecar.
      if (kind === "librespot" && !this.oauth.isAuthorized()) return false;

      if (this.started) {
        if (this.backend?.isReady()) return true;
        this.stop();
      }
      if (this.startPromise) return this.startPromise;

      this.startPromise = (async () => {
        try {
          const backend = this.buildBackend(kind);
          backend.on("trackEnded", (e: SpotifyTrackEndedEvent) =>
            this.emit("trackEnded", e),
          );
          backend.on("metadata", (m: SpotifyNowPlaying) =>
            this.emit("metadata", m),
          );
          // C3: do NOT re-emit "error". Log and mark not-ready so the next
          // ensureStarted() relaunches a fresh backend.
          backend.on("error", (err?: unknown) => this.handleBackendError(err));
          await backend.start();
          this.backend = backend;
          this.started = true;
          return true;
        } catch (err) {
          this.logger.error({ err }, "Spotify backend failed to start");
          this.startPromise = null;
          return false;
        }
      })();
      return this.startPromise;
    }

    /**
     * C3 backend-error handler. Never re-emits "error" (an unhandled "error" on
     * an EventEmitter throws). Logs, tears the errored backend down, and marks
     * the controller not-ready so the next ensureStarted() relaunches it.
     */
    private handleBackendError(err: unknown): void {
      this.logger.error({ err }, "Spotify backend error; marking not-ready");
      try {
        this.backend?.stop();
      } catch (stopErr) {
        this.logger.error(
          { err: stopErr },
          "Spotify backend stop() threw during error teardown",
        );
      }
      (this.backend as unknown as EventEmitter | null)?.removeAllListeners();
      this.backend = null;
      this.started = false;
      this.startPromise = null;
    }

    /** Ensure started, then play the spotify: URI. False on any failure. */
    async playTrack(uri: string): Promise<boolean> {
      const ok = await this.ensureStarted();
      if (!ok || !this.backend) return false;
      try {
        await this.backend.playTrack(uri);
        return true;
      } catch (err) {
        this.logger.error({ err, uri }, "Spotify playTrack failed");
        return false;
      }
    }

    async pause(): Promise<void> {
      if (this.backend) await this.backend.pause();
    }

    async resume(): Promise<void> {
      if (this.backend) await this.backend.resume();
    }

    async seek(ms: number): Promise<void> {
      if (this.backend) await this.backend.seek(ms);
    }

    getPcmStream(): Readable {
      if (!this.backend) {
        throw new Error("Spotify backend not started");
      }
      return this.backend.getPcmStream();
    }

    /**
     * Tear down the backend and reset lifecycle state (safe before start).
     * Mirrors handleBackendError's teardown so the NEXT ensureStarted() rebuilds
     * a fresh backend.
     */
    stop(): void {
      try {
        this.backend?.stop();
      } catch (stopErr) {
        this.logger.error(
          { err: stopErr },
          "Spotify backend stop() threw during teardown",
        );
      }
      (this.backend as unknown as EventEmitter | null)?.removeAllListeners();
      this.backend = null;
      this.started = false;
      this.startPromise = null;
    }
  }
  ```

- [ ] **Step 5.4 — Confirm Green.** Run:
  ```
  npx vitest run src/music/spotify/controller.test.ts
  ```
  Expected: ALL specs pass — every Stage-2 spec (isAvailable, ensureStarted idempotency, playTrack, transport delegation, event re-emission, C3 error handling, stop, per-bot ports) plus the new `chooseBackend` matrix (8 cases) and Rust auth-gate block (5 cases). Zero failures.

- [ ] **Step 5.5 — Typecheck.** Run:
  ```
  npx tsc --noEmit
  ```
  Expected: no output, exit 0. (Confirms the new `./rust-librespot.js`, `./spotify-oauth.js`, `./connect-api.js`, and Rust `./binary.js` imports resolve, `SpotifyBackendKind` narrows correctly in `buildBackend`, and `OAuthTokenStore`/`OAuthTokens` type-only imports are correct under ESM `.js` specifiers.)

- [ ] **Step 5.6 — Commit.** Run:
  ```
  git add src/music/spotify/controller.ts src/music/spotify/controller.test.ts
  git commit -m "$(cat <<'EOF'
  feat(spotify): backend selection + Rust librespot wiring in SpotifyController

  Add chooseBackend() honoring config.spotify.backend (go-librespot|librespot|
  auto) against platform + binary availability (auto: linux+go binary -> go;
  else librespot present -> Rust; else null). Controller now owns a shared
  SpotifyOAuth + SpotifyConnectApi passed to the Rust backend; isAvailable() =
  enabled && a backend is selectable; the Rust path additionally gates
  ensureStarted() on oauth.isAuthorized(). go-librespot path unchanged.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

**Notes / guardrails:**
- Not e2e-testable (no Premium account, Windows target). All tests are mocked/unit-level: `./binary.js` probes via the hoisted `bin` object, `SpotifyOAuth`/`SpotifyConnectApi` injected as fakes, and `backendFactory` prevents any real `RustLibrespotBackend`/`GoLibrespotBackend` spawn.
- `chooseBackend()` uses synchronous `existsSync(findLibrespot())` (mirroring the Stage-2 `existsSync(findGoLibrespot())` check) rather than the async `checkLibrespotAvailable()`, so `isAvailable()` stays synchronous exactly like Stage-2. The async `--version` probe belongs to first-run detection, not per-call gating.
- Existing Stage-2 tests stay behavior-unchanged; the only test edits are additive (Rust mock exports defaulting to an absent librespot binary, an `oauth` inject hook, and two new `describe` blocks). No existing assertion is modified.

---

### Task 6: Web OAuth endpoints + wiring

**Files:**
- CREATE `src/web/api/spotify.ts` — Express router (login / callback / status), DI-friendly (`SpotifyOAuthLike` seam so it needs no real network/crypto).
- CREATE `src/music/spotify/token-store.ts` — file-backed `OAuthTokenStore` under the data dir (mirrors `createCookieStore` in `src/music/auth.ts`, `mode: 0o600`). *(Not in the original Files list but required — the router needs a persisted store; keep it tiny and reuse the cookie-store pattern. If the spotify-oauth.ts task already ships a file store, delete this and import that instead.)*
- CREATE `src/web/api/spotify.test.ts` + `src/music/spotify/token-store.test.ts` — supertest + fs tests.
- MODIFY `src/web/server.ts` — add `spotifyOAuth?` to `WebServerOptions`, mount `/api/spotify` after `requireAuth`.
- MODIFY `src/index.ts` — build the process-wide token store + `SpotifyOAuth` (single Premium account), pass into `createWebServer`.
- `src/data/config.ts` — **no change** (reuse `spotify.clientId`/`spotify.deviceName`; own-app clientId → redirect at the web `/api/spotify/callback`, empty → librespot public client + its fixed `:5588/login` loopback listener handled by the backend task, not this router).

**Interfaces:**

Consumes (from the spotify-oauth.ts task — LOCKED CONTRACT):
```ts
class SpotifyOAuth {
  buildAuthorizeUrl(): { url: string; state: string }
  handleCallback(code: string, state: string): Promise<boolean>
  isAuthorized(): boolean
}
interface OAuthTokens { accessToken: string; refreshToken: string; expiresAt: number; scope: string }
interface OAuthTokenStore { load(): OAuthTokens | null; save(t: OAuthTokens): void; clear(): void }
```
Consumes (middleware): `requirePermission("platform.auth")`, `requireNotGuest` (both read `req.user.role` / `req.user.capabilities: Set<string>`, populated by the global `requireAuth`).

Produces:
```ts
// src/web/api/spotify.ts
export interface SpotifyOAuthLike {
  buildAuthorizeUrl(): { url: string; state: string };
  handleCallback(code: string, state: string): Promise<boolean>;
  isAuthorized(): boolean;
}
export interface SpotifyRouterOptions {
  oauth: SpotifyOAuthLike;
  logger: import("pino").Logger;
  getBackendInfo: () => { backend: string; deviceName: string };
  webUiRedirect?: string; // default "/"
}
export function createSpotifyRouter(opts: SpotifyRouterOptions): import("express").Router;

// src/music/spotify/token-store.ts
export function createSpotifyTokenStore(dir: string): import("./spotify-oauth.js").OAuthTokenStore;
```
`SpotifyOAuth` structurally satisfies `SpotifyOAuthLike`, so the real instance passes verbatim; tests inject a fake.

---

- [ ] **Step 1 — Write the failing router test** `src/web/api/spotify.test.ts` (supertest, fake oauth, no network):
```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createSpotifyRouter, type SpotifyOAuthLike } from "./spotify.js";

type Role = "admin" | "member" | "guest";
function makeApp(oauth: SpotifyOAuthLike, role: Role = "admin", caps: string[] = []) {
  const app = express();
  app.use(express.json());
  // Stand in for the global requireAuth that populates req.user.
  app.use((req, _res, next) => {
    (req as any).user = { role, capabilities: new Set(caps) };
    next();
  });
  app.use(
    "/api/spotify",
    createSpotifyRouter({
      oauth,
      logger: pino({ level: "silent" }),
      getBackendInfo: () => ({ backend: "librespot", deviceName: "TS-Bot" }),
      webUiRedirect: "/",
    }),
  );
  return app;
}

function fakeOauth(over: Partial<SpotifyOAuthLike> = {}): SpotifyOAuthLike {
  return {
    buildAuthorizeUrl: () => ({ url: "https://accounts.spotify.com/authorize?x=1", state: "st" }),
    handleCallback: async () => true,
    isAuthorized: () => false,
    ...over,
  };
}

describe("spotify OAuth router", () => {
  it("GET /login returns the authorize url for a permitted user", async () => {
    const app = makeApp(fakeOauth());
    const res = await request(app).get("/api/spotify/login");
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("accounts.spotify.com/authorize");
  });

  it("GET /login is 403 for a member lacking platform.auth", async () => {
    const app = makeApp(fakeOauth(), "member", []);
    const res = await request(app).get("/api/spotify/login");
    expect(res.status).toBe(403);
  });

  it("GET /callback with a good code+state redirects to success", async () => {
    const handleCallback = vi.fn(async () => true);
    const app = makeApp(fakeOauth({ handleCallback }));
    const res = await request(app).get("/api/spotify/callback?code=abc&state=st");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?spotify=success");
    expect(handleCallback).toHaveBeenCalledWith("abc", "st");
  });

  it("GET /callback with a bad state (handleCallback false) redirects to error", async () => {
    const app = makeApp(fakeOauth({ handleCallback: async () => false }));
    const res = await request(app).get("/api/spotify/callback?code=abc&state=WRONG");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?spotify=error");
  });

  it("GET /callback with missing code does not call oauth and redirects to error", async () => {
    const handleCallback = vi.fn(async () => true);
    const app = makeApp(fakeOauth({ handleCallback }));
    const res = await request(app).get("/api/spotify/callback?state=st");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?spotify=error");
    expect(handleCallback).not.toHaveBeenCalled();
  });

  it("GET /callback swallows a throwing handleCallback and redirects to error", async () => {
    const app = makeApp(fakeOauth({ handleCallback: async () => { throw new Error("boom"); } }));
    const res = await request(app).get("/api/spotify/callback?code=abc&state=st");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?spotify=error");
  });

  it("GET /status reflects authorized + backend + deviceName", async () => {
    const app = makeApp(fakeOauth({ isAuthorized: () => true }));
    const res = await request(app).get("/api/spotify/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorized: true, backend: "librespot", deviceName: "TS-Bot" });
  });

  it("GET /status is 403 for a guest", async () => {
    const app = makeApp(fakeOauth(), "guest");
    const res = await request(app).get("/api/spotify/status");
    expect(res.status).toBe(403);
  });
});
```
Run it — it MUST fail to compile/import (router does not exist yet):
`npx vitest run src/web/api/spotify.test.ts` → **expected: fails (Cannot find module './spotify.js')**.

- [ ] **Step 2 — Create the router** `src/web/api/spotify.ts` to make Step 1 pass:
```ts
import { Router } from "express";
import type { Logger } from "pino";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";

/** Minimal structural seam over SpotifyOAuth so this router needs no real
 *  network/crypto in tests. The concrete SpotifyOAuth satisfies it verbatim. */
export interface SpotifyOAuthLike {
  buildAuthorizeUrl(): { url: string; state: string };
  handleCallback(code: string, state: string): Promise<boolean>;
  isAuthorized(): boolean;
}

export interface SpotifyRouterOptions {
  oauth: SpotifyOAuthLike;
  logger: Logger;
  /** Process-wide backend info for /status (single Premium account, Stage 3). */
  getBackendInfo: () => { backend: string; deviceName: string };
  /** Web UI page to bounce the browser back to after the OAuth callback. */
  webUiRedirect?: string;
}

export function createSpotifyRouter(opts: SpotifyRouterOptions): Router {
  const { oauth, logger } = opts;
  const redirectBase = opts.webUiRedirect ?? "/";
  const sep = redirectBase.includes("?") ? "&" : "?";
  const router = Router();

  // Start the Authorization Code + PKCE flow: hand the WebUI the accounts.spotify.com
  // authorize URL (verifier is stashed by state inside SpotifyOAuth). Gated like the
  // other platform logins in auth.ts.
  router.get("/login", requirePermission("platform.auth"), (_req, res) => {
    try {
      const { url } = oauth.buildAuthorizeUrl();
      res.json({ url });
    } catch (err) {
      logger.error({ err }, "Spotify authorize URL build failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // OAuth redirect target (own-app clientId => redirect_uri points here). This is a
  // top-level browser navigation carrying the SameSite=Lax session cookie, so the
  // global requireAuth passes; state is the CSRF guard for the flow itself. Always
  // redirect (never JSON) so the user lands back in the UI.
  router.get("/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !state) {
      res.redirect(`${redirectBase}${sep}spotify=error`);
      return;
    }
    try {
      const ok = await oauth.handleCallback(code, state);
      res.redirect(`${redirectBase}${sep}spotify=${ok ? "success" : "error"}`);
    } catch (err) {
      logger.error({ err }, "Spotify OAuth callback failed");
      res.redirect(`${redirectBase}${sep}spotify=error`);
    }
  });

  // Whether the (single, process-wide) account is authorized, plus which backend
  // + device name are configured — used by the WebUI to show login-needed state.
  router.get("/status", requireNotGuest, (_req, res) => {
    const info = opts.getBackendInfo();
    res.json({
      authorized: oauth.isAuthorized(),
      backend: info.backend,
      deviceName: info.deviceName,
    });
  });

  return router;
}
```
`npx vitest run src/web/api/spotify.test.ts` → **expected: 8 passed**.

- [ ] **Step 3 — Write the failing token-store test** `src/music/spotify/token-store.test.ts` (real fs, tmp dir under the scratch/OS temp — no network):
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSpotifyTokenStore } from "./token-store.js";

describe("spotify token store", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-tok-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const sample = { accessToken: "at", refreshToken: "rt", expiresAt: 123, scope: "streaming" };

  it("returns null before anything is saved", () => {
    expect(createSpotifyTokenStore(dir).load()).toBeNull();
  });

  it("round-trips saved tokens", () => {
    const store = createSpotifyTokenStore(dir);
    store.save(sample);
    expect(createSpotifyTokenStore(dir).load()).toEqual(sample);
  });

  it("clear() removes the persisted tokens", () => {
    const store = createSpotifyTokenStore(dir);
    store.save(sample);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it("load() returns null on a corrupt / partial file", () => {
    fs.writeFileSync(path.join(dir, "oauth-tokens.json"), "{not json");
    expect(createSpotifyTokenStore(dir).load()).toBeNull();
    fs.writeFileSync(path.join(dir, "oauth-tokens.json"), JSON.stringify({ accessToken: "x" }));
    expect(createSpotifyTokenStore(dir).load()).toBeNull(); // no refreshToken
  });
});
```
`npx vitest run src/music/spotify/token-store.test.ts` → **expected: fails (module not found)**.

- [ ] **Step 4 — Create the token store** `src/music/spotify/token-store.ts`:
```ts
import fs from "node:fs";
import path from "node:path";
import type { OAuthTokens, OAuthTokenStore } from "./spotify-oauth.js";

const FILE = "oauth-tokens.json";

/** File-backed OAuthTokenStore under the data dir, mirroring createCookieStore
 *  (0o600 perms). Process-wide single account for Stage 3. */
export function createSpotifyTokenStore(dir: string): OAuthTokenStore {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, FILE);
  return {
    load(): OAuthTokens | null {
      if (!fs.existsSync(filePath)) return null;
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        // A stored token is only usable if it carries a refresh token — anything
        // else is treated as "not authorized" so getAccessToken() re-runs sign-in.
        if (!data || typeof data.refreshToken !== "string") return null;
        return data as OAuthTokens;
      } catch {
        return null;
      }
    },
    save(t: OAuthTokens): void {
      fs.writeFileSync(filePath, JSON.stringify(t), { encoding: "utf-8", mode: 0o600 });
    },
    clear(): void {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* already gone */
      }
    },
  };
}
```
`npx vitest run src/music/spotify/token-store.test.ts` → **expected: 4 passed**.

- [ ] **Step 5 — Mount in `src/web/server.ts`.** Add the import, extend options, mount after `requireAuth` (so `/login` + `/status` are gated and the callback carries the session cookie):
```ts
// with the other api imports:
import { createSpotifyRouter } from "./api/spotify.js";
import type { SpotifyOAuth } from "../music/spotify/spotify-oauth.js";
```
```ts
// in WebServerOptions (optional so existing call sites/tests keep compiling):
  spotifyOAuth?: SpotifyOAuth;
```
```ts
// after: app.use("/api/auth", createAuthRouter(...));
  if (options.spotifyOAuth) {
    app.use(
      "/api/spotify",
      createSpotifyRouter({
        oauth: options.spotifyOAuth,
        logger,
        getBackendInfo: () => ({
          backend: options.config.spotify.backend,
          deviceName: options.config.spotify.deviceName,
        }),
        webUiRedirect: "/",
      }),
    );
  }
```
*(The GET `/callback` is a safe method, so `csrfOriginCheck` — which only guards state-changing verbs — lets the top-level redirect through.)*

- [ ] **Step 6 — Wire `src/index.ts`.** Build the single process-wide token store + `SpotifyOAuth` and pass it to the web server. Own-app clientId (reused `spotify.clientId`) redirects to the web callback; empty clientId falls back to the librespot public client (its fixed `:5588/login` loopback listener belongs to the backend task):
```ts
// with the other spotify imports:
import { SpotifyOAuth } from "./music/spotify/spotify-oauth.js";
import { createSpotifyTokenStore } from "./music/spotify/token-store.js";
```
```ts
// after spotifyProvider setup, before createWebServer(...):
  const spotifyTokenStore = createSpotifyTokenStore(path.join(SPOTIFY_DATA_DIR, "oauth"));
  const ownClientId = config.spotify.clientId.trim();
  const spotifyOAuth = new SpotifyOAuth({
    clientId: ownClientId || undefined,
    redirectUri: ownClientId
      ? `http://127.0.0.1:${config.webPort}/api/spotify/callback`
      : undefined,
    store: spotifyTokenStore,
  });
```
```ts
// add to the createWebServer({ ... }) options object:
    spotifyOAuth,
```
*(This same `spotifyOAuth` instance is the one the Rust-backend/controller task hands to `BotManager` — it is the single shared authorization for the process. No `BotManager` change is required for Task 6; the status endpoint reads backend/device from config.)*

- [ ] **Step 7 — Typecheck + full verify.**
  - `npx tsc --noEmit` → **expected: no errors**.
  - `npx vitest run src/web/api/spotify.test.ts src/music/spotify/token-store.test.ts` → **expected: 12 passed**.
  - `npx vitest run src/web` → **expected: all web tests pass (no regression from the new mount/options)**.

- [ ] **Step 8 — Commit.**
```bash
git checkout -b stage3-task6-web-oauth
git add src/web/api/spotify.ts src/web/api/spotify.test.ts \
        src/music/spotify/token-store.ts src/music/spotify/token-store.test.ts \
        src/web/server.ts src/index.ts
git commit -m "$(cat <<'EOF'
feat(spotify): web OAuth endpoints + PKCE token store wiring (Stage 3, Task 6)

Add /api/spotify {login,callback,status} router behind the SpotifyOAuth seam,
a 0600 file-backed OAuthTokenStore under the data dir, and process-wide
SpotifyOAuth wiring in index.ts/server.ts. Router is DI-tested with supertest
(no network); store is fs-tested. Single Premium account for Stage 3.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Notes:** Not e2e-testable on Windows without a Premium account — all tests are unit/mock level (fake `SpotifyOAuthLike`, real fs tmp dir; no binary, no `accounts.spotify.com`). PKCE crypto (`node:crypto` verifier/challenge) is exercised in the spotify-oauth.ts task's own tests; this task only drives the already-built `SpotifyOAuth` through the HTTP surface.

---

### Task 7: Whole-stage verification

**Files:** none (verification only).

- [ ] **Step 1: Full backend suite** — `npx vitest run --no-file-parallelism` → all pass (existing + new Stage-3 unit tests; the go-librespot Stage-2 path still green).
- [ ] **Step 2: Typecheck + frontend build** — `npx tsc --noEmit && cd web && npm run build` → zero type errors; frontend builds.
- [ ] **Step 3: Gating sanity (documented, not live):** confirm by reading that when no `librespot` binary is present or OAuth is unauthorized, `SpotifyController.ensureStarted()` returns false → Stage-1 sentinel fallback (queue keeps moving), and the Stage-2 go-librespot path is unaffected on Linux. State in the report that live audio + the Spotify Connect control path were NOT verified here (need Premium + a real librespot + a real account) and list exactly what WAS verified (unit tests with mocked process/HTTP, PKCE crypto, tsc, build).
- [ ] **Step 4: Commit** — `git add -A && git commit -m "chore(spotify): stage 3 verification pass" --allow-empty`
