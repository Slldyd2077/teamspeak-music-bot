# Spotify Source — Stage 2 (go-librespot Audio Backend, Linux/Docker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Real Spotify audio playback on Linux/Docker via a go-librespot sidecar, fed as a continuous PCM stream through the existing voice pipeline; cleanly gated so non-Linux/unconfigured installs keep the Stage-1 "not playable yet" behavior.

**Architecture:** A per-bot `SpotifyController` owns a `GoLibrespotBackend` (implements `SpotifyAudioBackend`) that runs go-librespot as a sidecar (config.yml + REST + WebSocket) writing raw PCM to a FIFO, with one long-lived ffmpeg resampling 44.1k→48k. `AudioPlayer` gains an additive external-PCM mode (`playPcmStream`) that reuses its frame loop/encoder but is fed by the sidecar stream and advanced by the WebSocket `not_playing` event instead of ffmpeg EOF. `instance.ts` branches spotify songs to the controller and delegates transport.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Node 25, `axios` + `ws` (both already deps), `vitest`. External binary: go-librespot (Linux only).

## Global Constraints

- ESM: all relative imports use the `.js` extension.
- **Linux/Docker-only, gated:** the go-librespot backend activates ONLY when `isGoLibrespotSupported()` (`process.platform === "linux"`) AND `config.spotify.enabled` AND a resolvable `go-librespot` binary AND login succeeds. On any other platform or when unavailable, `resolveAndPlay` MUST fall back to the Stage-1 sentinel-skip message and keep the queue moving. Never crash an unconfigured/non-Linux install.
- **Not end-to-end testable here:** real audio needs Spotify Premium + Linux + a live sidecar. "Done" = code complete, unit-tested with INJECTED/mocked `child_process`/`http`/`ws`/`fs` (no real binary or network in tests), `tsc --noEmit` clean, full `vitest run` green. Do NOT claim audio "works" — only that the logic is unit-verified.
- **Additive only:** do NOT change the existing `AudioPlayer.play(url)` behavior or break any existing test. Every Stage-2 change to a tested file (`player.ts`, `instance.ts`) is additive and gated.
- Metadata keeps using the Stage-1 Client-Credentials Web API path unchanged; go-librespot interactive OAuth is ONLY for audio.
- PCM contract: go-librespot pipe emits s16le/44100/stereo; ffmpeg resamples to s16le/48000/stereo (the frame loop consumes `PCM_FRAME_BYTES = 3840`). `getPcmStream()` returns the 48k ffmpeg stdout `Readable`.
- No new npm deps (`ws` + `axios` already present). Do NOT add a YAML package — hand-build config.yml.
- The verified go-librespot facts (config keys, REST endpoints, WS event types, exact ffmpeg command, mkfifo/spawn patterns, release-asset naming) live in `.superpowers/sdd/stage2-integration-map.md` — the source of truth; implementers should read it.
- Run tests: `npx vitest run <path>`; typecheck `npx tsc --noEmit`; full suite `npx vitest run`.

## REQUIRED CORRECTIONS (post-review — these OVERRIDE the task sections below where they conflict)

The task sections were drafted before an adversarial review. Apply these corrections; they fix one blocker + several integration gaps that the mocked unit tests do not catch. The controller (Task 6) will pass exact instructions per task, but they are recorded here too.

**C1 (Task 4 — ffmpeg binary resolution).** Do NOT hard-code `spawn("ffmpeg", …)`. The repo resolves ffmpeg via `getFfmpegCommand()` in `src/audio/player.ts:50` (falls back to the bundled `ffmpeg-static` when `ffmpeg` is not on PATH — the Docker case). Add `export` to that function (`export function getFfmpegCommand()`), import it into `go-librespot.ts` (`import { getFfmpegCommand } from "../../audio/player.js"`), and resolve the ffmpeg command as `this.deps?.ffmpegCommand ?? getFfmpegCommand()`. Keep the FIFO-reader arg array exactly as the map specifies. In the test, inject `deps.ffmpegCommand = "ffmpeg"` so the arg-array assertion still pins the args while production honors the fallback.

**C2 (Task 5 — external-PCM teardown = DETACH, not destroy).** The external `Readable` is the backend's **long-lived, shared** ffmpeg stdout (one stream across all tracks). `stop()` and the internal fence inside `playPcmStream()` MUST detach (remove the `data`/`end`/`error` listeners the player added, `pause()` the readable) and clear `externalMode`/`onExternalEnd`/`externalStream` — they MUST NOT call `externalStream.destroy()` (that would kill the whole sidecar pipe for every future track). Add tests: (a) after one `playPcmStream(readable)`, pushing a first chunk then a LATER chunk both emit `frame`s with no re-attach (models a gapless track change driven by the sidecar); (b) a second `playPcmStream(newReadable)` detaches the first (first readable is NOT destroyed and no longer feeds `pcmBuffer`) and attaches the second; (c) `stop()` detaches without destroying and fences via `sessionId`; (d) the existing `play(url)` tests still pass unchanged. `getElapsed()` in external mode is frame-count based and therefore only APPROXIMATE for Spotify — acceptable for Stage 2, document it.

**C3 (Task 6 — no unhandled `error` event).** Node throws on an `EventEmitter` `"error"` event with no listener. The controller MUST subscribe to the backend's `"error"` (log via `logger`, mark itself not-ready so the next `ensureStarted()` can relaunch) and MUST NOT re-emit a raw `"error"` event. `getPcmStream()` returns the backend's single persistent stream (no per-attach `PassThrough`), paired with C2 and C4.

**C4 (Task 7 — gapless handoff, transport, occupancy, seek).**
- Add a private `currentSourceIsSpotify` flag. In `resolveAndPlay` for a **spotify** song: `ensureStarted()` → if false, keep the Stage-1 fallback message + `return false`; else `await controller.playTrack(uri)`; then **only if `!this.currentSourceIsSpotify`** call `this.player.playPcmStream(controller.getPcmStream(), { onExternalEnd })` (it internally fences the prior url-ffmpeg — do NOT also call `player.stop()`). If the previous song was already spotify, do NOT re-attach (leave the persistent stream flowing; go-librespot changes tracks into the same FIFO). Set `currentSourceIsSpotify = true`.
- In `resolveAndPlay` for a **non-spotify** song: if `this.currentSourceIsSpotify` was true, `this.spotifyController.pause().catch(…)` (stop the sidecar decoding) before the normal `player.play(url)` path; set `currentSourceIsSpotify = false`.
- `setupPlayerEvents`: `controller.on("trackEnded", () => { if (this.queue.current()?.platform === "spotify") this.playNext().catch(…) })`; rely on the `isAdvancing` guard.
- `cmdPause`/`cmdResume`/`cmdStop` AND `handleOccupancy` (≈333-353) AND `updateAutoPause` (≈311-315): when `this.queue.current()?.platform === "spotify"`, also delegate to `controller.pause()/resume()/stop()` (fire-and-forget `.catch`) alongside the existing `player.*` calls — occupancy auto-pause bypasses the cmd handlers, so it MUST be patched too or the sidecar keeps decoding into an empty channel.
- Web seek: add `BotInstance.seek(ms)` that routes to `controller.seek(ms)` when the current song is spotify, else `player.seek(ms)`; change `src/web/api/player.ts:201` from `bot.getPlayer().seek(position)` to `bot.seek(position)`. (Add `src/web/api/player.ts` to Task 7's file list.)

## File structure

**New:** `src/music/spotify/{binary,backend,go-librespot-config,go-librespot-api,go-librespot,controller}.ts` (+ `.test.ts` for each except `backend.ts` which is interface-only).
**Modified:** `src/audio/player.ts` (external-PCM mode), `src/bot/instance.ts` (spotify orchestration + transport delegation), `src/bot/manager.ts` + `src/index.ts` (thread controller construction params).

---

### Task 1: go-librespot binary resolver + platform gate

**Files:**
- CREATE `src/music/spotify/binary.ts`
- CREATE `src/music/spotify/binary.test.ts`

This is the leaf module of Stage 2 — it has no dependency on any other new Spotify file and nothing here modifies an existing tested file, so no existing behavior is at risk. It mirrors `src/music/youtube.ts` (`findYtDlp` / `checkYtDlpAvailable` / `resetYtDlpAvailabilityCache`) exactly, adjusting the bin depth (`src/music/spotify/` is one directory deeper than `src/music/`, so the repo `bin/` is reached via `../../../bin`) and adding the Linux support gate.

**Interfaces:**

Consumes (Node built-ins only — no new deps):
- `node:child_process` `execFile`, `node:util` `promisify`, `node:fs` `existsSync`, `node:url` `fileURLToPath`, `node:path` `dirname`/`join`.

Produces (locked contract — exact signatures):
- `export function isGoLibrespotSupported(): boolean`  // `process.platform === "linux"`
- `export function findGoLibrespot(): string`  // `bin/go-librespot` then PATH
- `export function resetGoLibrespotBinaryCache(): void`  // test hook
- `export async function checkGoLibrespotAvailable(): Promise<boolean>`  // supported && binary runs

Additive test-only seams (not part of the public backend contract; used only so the tests need no real binary and the locked functions stay param-free):
- `export function pickGoLibrespotPath(candidates: string[], exists: (p: string) => boolean): string` — pure ordering core behind `findGoLibrespot()`.
- `export function __setGoLibrespotVersionProbe(probe: ((bin: string) => Promise<void>) | null): void` — override/restore the `--version` probe.

---

- [ ] **Step 1: Write the failing test `src/music/spotify/binary.test.ts` (TDD red).**

  Full test file — asserts real path-ordering and gate/cache behavior, injecting the version probe and stubbing `process.platform` so no real binary or network is touched:

  ```ts
  import { describe, it, expect, vi, afterEach } from "vitest";
  import { join } from "node:path";
  import {
    isGoLibrespotSupported,
    pickGoLibrespotPath,
    findGoLibrespot,
    checkGoLibrespotAvailable,
    resetGoLibrespotBinaryCache,
    __setGoLibrespotVersionProbe,
  } from "./binary.js";

  const origPlatform = process.platform;
  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  }

  afterEach(() => {
    setPlatform(origPlatform);
    __setGoLibrespotVersionProbe(null);
    resetGoLibrespotBinaryCache();
  });

  describe("isGoLibrespotSupported", () => {
    it("is true only on linux", () => {
      setPlatform("linux");
      expect(isGoLibrespotSupported()).toBe(true);
      setPlatform("win32");
      expect(isGoLibrespotSupported()).toBe(false);
      setPlatform("darwin");
      expect(isGoLibrespotSupported()).toBe(false);
    });
  });

  describe("pickGoLibrespotPath (bin/ then PATH ordering)", () => {
    const binPath = join("some", "root", "bin", "go-librespot");

    it("prefers the bin/ path when the file exists", () => {
      expect(
        pickGoLibrespotPath([binPath, "go-librespot"], (p) => p === binPath),
      ).toBe(binPath);
    });

    it("falls through to the bare PATH name when the bin/ file is missing", () => {
      expect(pickGoLibrespotPath([binPath, "go-librespot"], () => false)).toBe(
        "go-librespot",
      );
    });

    it("returns bare command names without touching the filesystem", () => {
      const exists = vi.fn(() => false);
      expect(pickGoLibrespotPath(["go-librespot"], exists)).toBe("go-librespot");
      expect(exists).not.toHaveBeenCalled();
    });
  });

  describe("findGoLibrespot", () => {
    it("returns the bare command name when bin/go-librespot is absent", () => {
      // No go-librespot binary is committed under bin/, so resolution must
      // fall back to the bare PATH name (execFile resolves it at run time).
      expect(findGoLibrespot()).toBe("go-librespot");
    });
  });

  describe("checkGoLibrespotAvailable", () => {
    it("returns false immediately on unsupported platforms without probing", async () => {
      setPlatform("darwin");
      const probe = vi.fn(async () => {});
      __setGoLibrespotVersionProbe(probe);
      expect(await checkGoLibrespotAvailable()).toBe(false);
      expect(probe).not.toHaveBeenCalled();
    });

    it("returns true when the binary responds to --version on linux", async () => {
      setPlatform("linux");
      __setGoLibrespotVersionProbe(async () => {});
      expect(await checkGoLibrespotAvailable()).toBe(true);
    });

    it("caches only positive results and probes once", async () => {
      setPlatform("linux");
      const probe = vi.fn(async () => {});
      __setGoLibrespotVersionProbe(probe);
      expect(await checkGoLibrespotAvailable()).toBe(true);
      expect(await checkGoLibrespotAvailable()).toBe(true);
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it("does not cache a failed probe (retries on the next call)", async () => {
      setPlatform("linux");
      __setGoLibrespotVersionProbe(async () => {
        throw new Error("ENOENT");
      });
      expect(await checkGoLibrespotAvailable()).toBe(false);
      // A later successful probe must now succeed — negatives are not cached.
      __setGoLibrespotVersionProbe(async () => {});
      expect(await checkGoLibrespotAvailable()).toBe(true);
    });

    it("resetGoLibrespotBinaryCache clears a cached positive", async () => {
      setPlatform("linux");
      __setGoLibrespotVersionProbe(async () => {});
      expect(await checkGoLibrespotAvailable()).toBe(true);
      resetGoLibrespotBinaryCache();
      __setGoLibrespotVersionProbe(async () => {
        throw new Error("gone");
      });
      expect(await checkGoLibrespotAvailable()).toBe(false);
    });
  });
  ```

  Verify (expected FAIL — module does not exist yet):
  ```
  npx vitest run src/music/spotify/binary.test.ts
  ```
  Expected: suite errors / cannot resolve `./binary.js`.

- [ ] **Step 2: Implement `src/music/spotify/binary.ts` (TDD green).**

  Full implementation — mirrors `youtube.ts` conventions (`execFileAsync`, 5s timeout, `maxBuffer: 1024`, cache-positive-only) with the Linux gate and the `../../../bin` depth:

  ```ts
  import { execFile } from "node:child_process";
  import { promisify } from "node:util";
  import { existsSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  import { dirname, join } from "node:path";

  const execFileAsync = promisify(execFile);

  const __dirname = dirname(fileURLToPath(import.meta.url));

  /**
   * True only on Linux. go-librespot ships Linux-only release binaries and the
   * sidecar relies on a POSIX FIFO (mkfifo), so the Spotify audio backend is
   * gated to Linux/Docker. Everywhere else the caller falls back to the Stage-1
   * sentinel-skip message.
   */
  export function isGoLibrespotSupported(): boolean {
    return process.platform === "linux";
  }

  /**
   * Pure resolver core behind findGoLibrespot(). Returns the first candidate
   * that is either a bare command name (left for execFile to resolve via PATH)
   * or an existing bin/ file. Exported so tests can inject candidates + a fake
   * existence predicate and need no real binary on disk.
   */
  export function pickGoLibrespotPath(
    candidates: string[],
    exists: (p: string) => boolean,
  ): string {
    for (const c of candidates) {
      // bin/ paths only count when the file is actually present; bare names are
      // returned unconditionally and resolved later via PATH.
      const isBinPath = c.includes(join("bin", "go-librespot"));
      if (!isBinPath || exists(c)) return c;
    }
    return "go-librespot";
  }

  /** Resolve the go-librespot binary path: project bin/ dir first, then PATH. */
  export function findGoLibrespot(): string {
    // src/music/spotify -> ../../../bin (one level deeper than youtube.ts).
    const binPath = join(__dirname, "..", "..", "..", "bin", "go-librespot");
    return pickGoLibrespotPath([binPath, "go-librespot"], existsSync);
  }

  // Injectable `--version` probe. Defaults to the real execFile call; tests
  // override it so checkGoLibrespotAvailable() needs no real binary. Keeps the
  // public checkGoLibrespotAvailable() signature param-free per the contract.
  type VersionProbe = (bin: string) => Promise<void>;
  const realProbe: VersionProbe = async (bin) => {
    await execFileAsync(bin, ["--version"], { timeout: 5_000, maxBuffer: 1024 });
  };
  let versionProbe: VersionProbe = realProbe;

  /** Test hook: override the `--version` probe, or restore the default with null. */
  export function __setGoLibrespotVersionProbe(
    probe: VersionProbe | null,
  ): void {
    versionProbe = probe ?? realProbe;
  }

  /**
   * Availability check for go-librespot. Returns false immediately on non-Linux
   * platforms (unsupported). Otherwise runs `go-librespot --version` (5s timeout)
   * and caches ONLY the positive result — a missing binary is retried on the
   * next call so the operator can install it without restarting the server.
   */
  let cachedAvailable = false;
  let pendingCheck: Promise<boolean> | null = null;
  export async function checkGoLibrespotAvailable(): Promise<boolean> {
    if (!isGoLibrespotSupported()) return false;
    if (cachedAvailable) return true;
    if (pendingCheck) return pendingCheck;
    pendingCheck = (async () => {
      try {
        await versionProbe(findGoLibrespot());
        cachedAvailable = true;
        return true;
      } catch {
        return false;
      } finally {
        pendingCheck = null;
      }
    })();
    return pendingCheck;
  }

  /** Force re-detection on the next call (for tests). */
  export function resetGoLibrespotBinaryCache(): void {
    cachedAvailable = false;
    pendingCheck = null;
  }
  ```

  Verify (expected PASS — all cases green):
  ```
  npx vitest run src/music/spotify/binary.test.ts
  ```
  Expected: all tests pass (isGoLibrespotSupported gate, bin-first/PATH-fallback ordering, unsupported-gate short-circuit with no probe call, positive-only caching probed once, negative-not-cached retry, cache reset).

- [ ] **Step 3: Typecheck.**
  ```
  npx tsc --noEmit
  ```
  Expected: PASS (no errors). `NodeJS.Platform` comes from `@types/node` globals; NodeNext/ESM `.js` import specifier resolves to `binary.ts`.

- [ ] **Step 4: Commit.**
  ```
  git add src/music/spotify/binary.ts src/music/spotify/binary.test.ts
  git commit -m "$(cat <<'EOF'
  feat(spotify): add go-librespot binary resolver + Linux support gate

  Mirror youtube.ts findYtDlp/checkYtDlpAvailable (bin/ then PATH,
  cache-positive-only availability, reset test hook) and add
  isGoLibrespotSupported() Linux gate for the Stage 2 audio backend.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

Now I have everything needed. Here is the task section.

---

### Task 2: SpotifyAudioBackend interface + config.yml generator

**Files:**
- CREATE `src/music/spotify/backend.ts` (interface + DTOs only, no runtime code)
- CREATE `src/music/spotify/go-librespot-config.ts` (`renderConfigYml`)
- CREATE `src/music/spotify/go-librespot-config.test.ts` (vitest)

**Interfaces:**

Consumes (nothing external — these are pure/declaration modules):
- `GoLibrespotConfigOptions { deviceName: string; bitrate: number; fifoPath: string; apiAddress: string; apiPort: number; callbackPort: number }`

Produces (exact signatures from the locked contract):
- `backend.ts` — `export interface SpotifyTrackEndedEvent { uri: string; reason: "ended" | "stopped" | "error" }`
- `backend.ts` — `export interface SpotifyNowPlaying { uri: string; name: string; artist: string; album: string; coverUrl: string; durationMs: number }`
- `backend.ts` — `export interface SpotifyAudioBackend { start(): Promise<void>; stop(): void; isReady(): boolean; playTrack(uri: string): Promise<void>; pause(): Promise<void>; resume(): Promise<void>; seek(ms: number): Promise<void>; getPcmStream(): import("node:stream").Readable; getPositionMs(): number; on(event, cb): void }`
- `go-librespot-config.ts` — `export interface GoLibrespotConfigOptions { ... }`
- `go-librespot-config.ts` — `export function renderConfigYml(o: GoLibrespotConfigOptions): string`

Notes: Both new files are self-contained (no imports from existing tested modules), so nothing existing changes or breaks. `backend.ts` is types-only — it is consumed by `go-librespot.ts` and `controller.ts` in later tasks. No `yaml` dependency is added; the config is a hand-built string and the test verifies it by exact-line assertions plus a minimal structural parse.

---

- [ ] **Step 1: Create `backend.ts` — the interface + two event DTOs, interface-only (no runtime code).**

  Create `src/music/spotify/backend.ts` with exactly the locked contract (ESM, but note this file has no runtime imports — the `Readable` type is referenced inline via `import("node:stream")` so nothing is emitted):

  ```ts
  // src/music/spotify/backend.ts
  // Type contract for the Spotify audio backend (go-librespot sidecar).
  // Interface-only: this module intentionally contains NO runtime code so it
  // can be imported for types by go-librespot.ts and controller.ts without
  // pulling in child_process/ws/ffmpeg at type-check time.

  /** Emitted when the currently playing Spotify track finishes or is stopped. */
  export interface SpotifyTrackEndedEvent {
    uri: string;
    reason: "ended" | "stopped" | "error";
  }

  /** Now-playing metadata surfaced from the go-librespot "metadata" event. */
  export interface SpotifyNowPlaying {
    uri: string;
    name: string;
    artist: string;
    album: string;
    coverUrl: string;
    durationMs: number;
  }

  /**
   * Long-lived Spotify audio source: owns the go-librespot sidecar + FIFO->ffmpeg
   * PCM pipe and exposes transport control plus a continuous 48kHz s16le stereo
   * PCM stream to feed AudioPlayer.playPcmStream().
   */
  export interface SpotifyAudioBackend {
    start(): Promise<void>;
    stop(): void;
    isReady(): boolean;
    playTrack(uri: string): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    seek(ms: number): Promise<void>;
    getPcmStream(): import("node:stream").Readable;
    getPositionMs(): number;
    on(event: "trackEnded", cb: (e: SpotifyTrackEndedEvent) => void): void;
    on(event: "metadata", cb: (m: SpotifyNowPlaying) => void): void;
    on(event: "ready" | "error", cb: (arg?: unknown) => void): void;
  }
  ```

  Verify it type-checks (no runtime output expected):
  - Run: `npx tsc --noEmit`
  - Expected: PASS (exit 0). `backend.ts` has no value-level exports, so nothing to unit-test here; it is exercised by later tasks.

- [ ] **Step 2 (RED): Write the failing test for `renderConfigYml`.**

  Create `src/music/spotify/go-librespot-config.test.ts`. The test asserts the rendered YAML contains the exact keys/values from the GO-LIBRESPOT CONCRETE FACTS (pipe backend, `s16le`, `device_type: computer`, server enabled, `credentials.type: interactive`), and round-trips through a tiny dependency-free structural parser (we do NOT add a yaml package). Assertions are on real rendered output, not mocks:

  ```ts
  // src/music/spotify/go-librespot-config.test.ts
  import { describe, it, expect } from "vitest";
  import { renderConfigYml, type GoLibrespotConfigOptions } from "./go-librespot-config.js";

  const OPTS: GoLibrespotConfigOptions = {
    deviceName: "TeamSpeak Music Bot",
    bitrate: 320,
    fifoPath: "/tmp/go-librespot.fifo",
    apiAddress: "0.0.0.0",
    apiPort: 3678,
    callbackPort: 8080,
  };

  /**
   * Minimal 2-level YAML reader for the exact shape renderConfigYml emits
   * (flat scalars + one level of nesting under `server:` / `credentials:`).
   * Avoids adding a yaml dependency while still proving the output round-trips.
   */
  function parseTinyYaml(src: string): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
      { indent: -1, obj: root },
    ];
    for (const rawLine of src.split("\n")) {
      if (rawLine.trim() === "") continue;
      const indent = rawLine.length - rawLine.trimStart().length;
      const line = rawLine.trim();
      const idx = line.indexOf(":");
      const key = line.slice(0, idx).trim();
      let valRaw = line.slice(idx + 1).trim();
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1].obj;
      if (valRaw === "") {
        const child: Record<string, unknown> = {};
        parent[key] = child;
        stack.push({ indent, obj: child });
        continue;
      }
      let val: unknown = valRaw;
      if (valRaw.startsWith('"') && valRaw.endsWith('"')) val = JSON.parse(valRaw);
      else if (valRaw === "true") val = true;
      else if (valRaw === "false") val = false;
      else if (/^-?\d+$/.test(valRaw)) val = Number(valRaw);
      parent[key] = val;
    }
    return root;
  }

  describe("renderConfigYml", () => {
    it("emits the exact top-level go-librespot keys/values", () => {
      const lines = renderConfigYml(OPTS).split("\n");
      expect(lines).toContain('device_name: "TeamSpeak Music Bot"');
      expect(lines).toContain("device_type: computer");
      expect(lines).toContain("bitrate: 320");
      expect(lines).toContain("audio_backend: pipe");
      expect(lines).toContain("audio_output_pipe: /tmp/go-librespot.fifo");
      expect(lines).toContain("audio_output_pipe_format: s16le");
    });

    it("emits a server block with enabled/address/port set explicitly", () => {
      const parsed = parseTinyYaml(renderConfigYml(OPTS));
      expect(parsed.server).toEqual({
        enabled: true,
        address: "0.0.0.0",
        port: 3678,
      });
    });

    it("emits interactive OAuth credentials with the callback port", () => {
      const parsed = parseTinyYaml(renderConfigYml(OPTS));
      expect(parsed.credentials).toEqual({
        type: "interactive",
        interactive: { callback_port: 8080 },
      });
    });

    it("full round-trip reflects every provided option", () => {
      const parsed = parseTinyYaml(renderConfigYml(OPTS));
      expect(parsed).toEqual({
        device_name: "TeamSpeak Music Bot",
        device_type: "computer",
        bitrate: 320,
        audio_backend: "pipe",
        audio_output_pipe: "/tmp/go-librespot.fifo",
        audio_output_pipe_format: "s16le",
        server: { enabled: true, address: "0.0.0.0", port: 3678 },
        credentials: { type: "interactive", interactive: { callback_port: 8080 } },
      });
    });

    it("threads distinct option values through unchanged (no hard-coded ports)", () => {
      const parsed = parseTinyYaml(
        renderConfigYml({
          deviceName: "Other Bot",
          bitrate: 160,
          fifoPath: "/run/librespot/pipe",
          apiAddress: "127.0.0.1",
          apiPort: 4000,
          callbackPort: 9099,
        }),
      );
      expect(parsed).toMatchObject({
        device_name: "Other Bot",
        bitrate: 160,
        audio_output_pipe: "/run/librespot/pipe",
        server: { address: "127.0.0.1", port: 4000 },
        credentials: { interactive: { callback_port: 9099 } },
      });
    });

    it("safely quotes device names containing special characters", () => {
      const yml = renderConfigYml({ ...OPTS, deviceName: 'My "Cool" Bot' });
      expect(yml.split("\n")).toContain('device_name: "My \\"Cool\\" Bot"');
      // and still round-trips back to the original string
      expect(parseTinyYaml(yml).device_name).toBe('My "Cool" Bot');
    });
  });
  ```

  Run it (module does not exist yet):
  - Run: `npx vitest run src/music/spotify/go-librespot-config.test.ts`
  - Expected: FAIL (cannot resolve `./go-librespot-config.js`).

- [ ] **Step 3 (GREEN): Implement `renderConfigYml` as a hand-built string.**

  Create `src/music/spotify/go-librespot-config.ts`. Values are threaded from the options; `device_type`/`audio_backend`/`audio_output_pipe_format`/`credentials.type` are fixed per the confirmed go-librespot facts. `device_name` is quoted via `JSON.stringify` so spaces/quotes are escaped safely (valid YAML double-quoted scalar):

  ```ts
  // src/music/spotify/go-librespot-config.ts
  // Hand-built go-librespot config.yml. Keys/values verified against
  // devgianlu/go-librespot cmd/daemon/cli_config.go koanf tags. No yaml
  // dependency is used; the file is a small, fixed-shape document.

  export interface GoLibrespotConfigOptions {
    deviceName: string;
    bitrate: number;
    fifoPath: string;
    apiAddress: string;
    apiPort: number;
    callbackPort: number;
  }

  /**
   * Render a headless go-librespot config.yml:
   *  - pipe audio backend writing raw 44.1kHz/s16le stereo PCM to a FIFO,
   *  - HTTP+WebSocket control server enabled (port has NO built-in default,
   *    so it is always written explicitly),
   *  - interactive OAuth credentials (persisted automatically to
   *    <config_dir>/credentials.json after first login).
   */
  export function renderConfigYml(o: GoLibrespotConfigOptions): string {
    return (
      [
        `device_name: ${JSON.stringify(o.deviceName)}`,
        `device_type: computer`,
        `bitrate: ${o.bitrate}`,
        `audio_backend: pipe`,
        `audio_output_pipe: ${o.fifoPath}`,
        `audio_output_pipe_format: s16le`,
        `server:`,
        `  enabled: true`,
        `  address: ${o.apiAddress}`,
        `  port: ${o.apiPort}`,
        `credentials:`,
        `  type: interactive`,
        `  interactive:`,
        `    callback_port: ${o.callbackPort}`,
      ].join("\n") + "\n"
    );
  }
  ```

  Re-run the test:
  - Run: `npx vitest run src/music/spotify/go-librespot-config.test.ts`
  - Expected: PASS (6 tests green).

- [ ] **Step 4: Type-check the whole project (confirms `backend.ts` + config module compile and nothing else regressed).**
  - Run: `npx tsc --noEmit`
  - Expected: PASS (exit 0).

- [ ] **Step 5: Commit.**
  - Run: `git add src/music/spotify/backend.ts src/music/spotify/go-librespot-config.ts src/music/spotify/go-librespot-config.test.ts`
  - Run:
    ```
    git commit -m "$(cat <<'EOF'
    feat(spotify): add SpotifyAudioBackend interface + go-librespot config.yml renderer

    - backend.ts: type-only SpotifyAudioBackend contract + track/metadata DTOs
    - go-librespot-config.ts: renderConfigYml() hand-built config (pipe/s16le,
      server enabled, interactive OAuth), no yaml dependency
    - tests assert exact keys/values and round-trip via a tiny structural parser

    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    EOF
    )"
    ```
  - Expected: commit succeeds on the current feature branch (do not commit to `main`; branch first if on `main`).

---

### Task 3: go-librespot REST client + WebSocket event client

**Files:**
- CREATE `src/music/spotify/go-librespot-api.ts`
- CREATE `src/music/spotify/go-librespot-api.test.ts`

**Interfaces:**

Consumes (external):
- `axios` (`axios.create` style mirrored from `src/music/bilibili.ts:43`), injected for tests via `deps.http: import("axios").AxiosInstance`
- `ws` package `WebSocket` (default), injected for tests via `deps.WebSocketCtor`
- `node:events` `EventEmitter` (base class for the event client)
- go-librespot REST/WS facts from the map: `POST /player/play {uri}`, `/player/pause`, `/player/resume`, `/player/stop`, `POST /player/seek {position, relative:false}` (position in **ms**), `GET /status` (track.position/duration in **ms**), `GET /` reachability, `ws://…/events` envelope `{"type","data"}`

Produces (locked contract, verbatim):
```ts
export interface GoLibrespotStatusTrack { uri: string; name: string; artist_names: string[]; album_name: string; album_cover_url: string | null; position: number; duration: number }
export interface GoLibrespotStatus { stopped: boolean; paused: boolean; buffering: boolean; track: GoLibrespotStatusTrack | null }
export class GoLibrespotRestClient {
  constructor(baseUrl: string, deps?: { http?: import("axios").AxiosInstance })
  ping(): Promise<boolean>                 // GET / -> 200; false on error
  playTrack(uri: string): Promise<void>    // POST /player/play {uri}
  pause(): Promise<void>                    // POST /player/pause
  resume(): Promise<void>                   // POST /player/resume
  stop(): Promise<void>                     // POST /player/stop
  seek(ms: number): Promise<void>           // POST /player/seek {position: ms, relative: false}
  getStatus(): Promise<GoLibrespotStatus | null>   // GET /status; null on error
}
export type GoLibrespotEventType = "metadata"|"playing"|"paused"|"not_playing"|"stopped"|"will_play"|"seek"|"active"|"inactive"|"volume"|"playback_ready"
export class GoLibrespotEventClient extends EventEmitter {
  constructor(wsUrl: string, deps?: { WebSocketCtor?: any })
  start(): void
  stop(): void
  // emits (msg.type as-is) with msg.data; e.g. .on("not_playing", d => …), .on("metadata", d => …)
}
```

---

- [ ] **Step 1: Write the REST-client tests first (red).**
  Create `src/music/spotify/go-librespot-api.test.ts`. Import from the not-yet-existent module so the run fails on missing module / assertions. Assert exact method + path + body, and the error-swallowing contract (`ping`→`false`, `getStatus`→`null`).

  ```ts
  import { describe, it, expect, vi } from "vitest";
  import type { AxiosInstance } from "axios";
  import { GoLibrespotRestClient } from "./go-librespot-api.js";

  /** Minimal axios stub: only get/post are exercised by the client. */
  function makeHttp(overrides?: Partial<Record<"get" | "post", any>>) {
    return {
      get: vi.fn().mockResolvedValue({ status: 200, data: {} }),
      post: vi.fn().mockResolvedValue({ status: 200, data: {} }),
      ...overrides,
    } as unknown as AxiosInstance;
  }

  describe("GoLibrespotRestClient", () => {
    it("ping() returns true on GET / -> 200", async () => {
      const http = makeHttp();
      const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
      await expect(client.ping()).resolves.toBe(true);
      expect(http.get).toHaveBeenCalledWith("/");
    });

    it("ping() returns false when GET / rejects (daemon not up)", async () => {
      const http = makeHttp({ get: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) });
      const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
      await expect(client.ping()).resolves.toBe(false);
    });

    it("playTrack() POSTs /player/play with the uri body", async () => {
      const http = makeHttp();
      const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
      await client.playTrack("spotify:track:abc123");
      expect(http.post).toHaveBeenCalledWith("/player/play", { uri: "spotify:track:abc123" });
    });

    it("pause/resume/stop POST their bodyless endpoints", async () => {
      const http = makeHttp();
      const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
      await client.pause();
      await client.resume();
      await client.stop();
      expect(http.post).toHaveBeenNthCalledWith(1, "/player/pause");
      expect(http.post).toHaveBeenNthCalledWith(2, "/player/resume");
      expect(http.post).toHaveBeenNthCalledWith(3, "/player/stop");
    });

    it("seek() POSTs /player/seek with position(ms) and relative:false", async () => {
      const http = makeHttp();
      const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
      await client.seek(42000);
      expect(http.post).toHaveBeenCalledWith("/player/seek", { position: 42000, relative: false });
    });

    it("playTrack() rejects when the POST fails (surfaced to caller)", async () => {
      const http = makeHttp({ post: vi.fn().mockRejectedValue(new Error("boom")) });
      const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
      await expect(client.playTrack("spotify:track:x")).rejects.toThrow("boom");
    });

    it("getStatus() normalizes the /status shape (ms position/duration)", async () => {
      const http = makeHttp({
        get: vi.fn().mockResolvedValue({
          status: 200,
          data: {
            stopped: false,
            paused: false,
            buffering: false,
            track: {
              uri: "spotify:track:abc",
              name: "Song",
              artist_names: ["A", "B"],
              album_name: "Alb",
              album_cover_url: "https://i.scdn.co/c.jpg",
              position: 12345,
              duration: 200000,
            },
          },
        }),
      });
      const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
      const status = await client.getStatus();
      expect(http.get).toHaveBeenCalledWith("/status");
      expect(status).toEqual({
        stopped: false,
        paused: false,
        buffering: false,
        track: {
          uri: "spotify:track:abc",
          name: "Song",
          artist_names: ["A", "B"],
          album_name: "Alb",
          album_cover_url: "https://i.scdn.co/c.jpg",
          position: 12345,
          duration: 200000,
        },
      });
    });

    it("getStatus() returns null with a null track when nothing is loaded", async () => {
      const http = makeHttp({ get: vi.fn().mockResolvedValue({ status: 200, data: { stopped: true, paused: false, buffering: false, track: null } }) });
      const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
      const status = await client.getStatus();
      expect(status).toEqual({ stopped: true, paused: false, buffering: false, track: null });
    });

    it("getStatus() returns null when GET /status rejects", async () => {
      const http = makeHttp({ get: vi.fn().mockRejectedValue(new Error("down")) });
      const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
      await expect(client.getStatus()).resolves.toBeNull();
    });
  });
  ```

  Verify (expect FAIL — module `./go-librespot-api.js` does not exist yet):
  ```
  npx vitest run src/music/spotify/go-librespot-api.test.ts
  ```

- [ ] **Step 2: Implement `GoLibrespotRestClient` (green).**
  Create `src/music/spotify/go-librespot-api.ts`. `axios.create` mirrors the `baseURL`/`timeout`/`headers` style of `src/music/bilibili.ts:43`. `ping`/`getStatus` swallow errors per contract; the mutating ops let rejections propagate. (The `EventEmitter`/`ws` imports are added now so Step 4 needs no re-edit of the header.)

  ```ts
  import { EventEmitter } from "node:events";
  import axios, { type AxiosInstance } from "axios";
  import WebSocket from "ws";

  export interface GoLibrespotStatusTrack {
    uri: string;
    name: string;
    artist_names: string[];
    album_name: string;
    album_cover_url: string | null;
    position: number;
    duration: number;
  }

  export interface GoLibrespotStatus {
    stopped: boolean;
    paused: boolean;
    buffering: boolean;
    track: GoLibrespotStatusTrack | null;
  }

  export class GoLibrespotRestClient {
    private http: AxiosInstance;

    constructor(baseUrl: string, deps?: { http?: AxiosInstance }) {
      this.http =
        deps?.http ??
        axios.create({
          baseURL: baseUrl,
          timeout: 10000,
          headers: { "Content-Type": "application/json" },
        });
    }

    async ping(): Promise<boolean> {
      try {
        const res = await this.http.get("/");
        return res.status === 200;
      } catch {
        return false;
      }
    }

    async playTrack(uri: string): Promise<void> {
      await this.http.post("/player/play", { uri });
    }

    async pause(): Promise<void> {
      await this.http.post("/player/pause");
    }

    async resume(): Promise<void> {
      await this.http.post("/player/resume");
    }

    async stop(): Promise<void> {
      await this.http.post("/player/stop");
    }

    async seek(ms: number): Promise<void> {
      await this.http.post("/player/seek", { position: ms, relative: false });
    }

    async getStatus(): Promise<GoLibrespotStatus | null> {
      try {
        const res = await this.http.get("/status");
        const d = res.data ?? {};
        const t = d.track;
        return {
          stopped: Boolean(d.stopped),
          paused: Boolean(d.paused),
          buffering: Boolean(d.buffering),
          track: t
            ? {
                uri: t.uri ?? "",
                name: t.name ?? "",
                artist_names: Array.isArray(t.artist_names) ? t.artist_names : [],
                album_name: t.album_name ?? "",
                album_cover_url: t.album_cover_url ?? null,
                position: t.position ?? 0,
                duration: t.duration ?? 0,
              }
            : null,
        };
      } catch {
        return null;
      }
    }
  }
  ```

  Verify (expect PASS for the REST describe; the WS describe does not exist yet):
  ```
  npx vitest run src/music/spotify/go-librespot-api.test.ts
  ```

- [ ] **Step 3: Add the event-client tests (red).**
  Append to `src/music/spotify/go-librespot-api.test.ts`. Use a `FakeWebSocket` (an `EventEmitter`) injected via `deps.WebSocketCtor` so no real socket opens; assert the parsed `type` is emitted with `data`, focusing on `not_playing` (track-end) and `metadata`, plus reconnect-on-close (fake timers) and `stop()` teardown. Update the top import to include `GoLibrespotEventClient`.

  Change the existing import line:
  ```ts
  import { GoLibrespotRestClient, GoLibrespotEventClient } from "./go-librespot-api.js";
  ```
  Then add (after the REST `describe`):
  ```ts
  import { EventEmitter } from "node:events";

  /** Fake ws: records instances, lets tests drive open/message/close/error. */
  class FakeWebSocket extends EventEmitter {
    static instances: FakeWebSocket[] = [];
    closed = false;
    constructor(public url: string) {
      super();
      FakeWebSocket.instances.push(this);
    }
    close() {
      this.closed = true;
      this.emit("close");
    }
  }

  function frame(type: string, data: unknown): Buffer {
    return Buffer.from(JSON.stringify({ type, data }));
  }

  describe("GoLibrespotEventClient", () => {
    beforeEach(() => {
      FakeWebSocket.instances = [];
    });

    it("emits 'not_playing' (track-end) with its data payload", () => {
      const client = new GoLibrespotEventClient("ws://127.0.0.1:3678/events", {
        WebSocketCtor: FakeWebSocket as any,
      });
      const onEnded = vi.fn();
      client.on("not_playing", onEnded);
      client.start();

      const ws = FakeWebSocket.instances[0];
      expect(ws.url).toBe("ws://127.0.0.1:3678/events");
      ws.emit("message", frame("not_playing", { uri: "spotify:track:abc", play_origin: "go-librespot" }));

      expect(onEnded).toHaveBeenCalledTimes(1);
      expect(onEnded).toHaveBeenCalledWith({ uri: "spotify:track:abc", play_origin: "go-librespot" });
      client.stop();
    });

    it("emits 'metadata' with the now-playing object", () => {
      const client = new GoLibrespotEventClient("ws://127.0.0.1:3678/events", {
        WebSocketCtor: FakeWebSocket as any,
      });
      const onMeta = vi.fn();
      client.on("metadata", onMeta);
      client.start();

      FakeWebSocket.instances[0].emit(
        "message",
        frame("metadata", { uri: "spotify:track:xyz", name: "Song", artist_names: ["Q"], duration: 200000 }),
      );

      expect(onMeta).toHaveBeenCalledWith({ uri: "spotify:track:xyz", name: "Song", artist_names: ["Q"], duration: 200000 });
      client.stop();
    });

    it("ignores non-JSON frames without throwing", () => {
      const client = new GoLibrespotEventClient("ws://x/events", { WebSocketCtor: FakeWebSocket as any });
      const onAny = vi.fn();
      client.on("metadata", onAny);
      client.start();
      expect(() => FakeWebSocket.instances[0].emit("message", Buffer.from("not json"))).not.toThrow();
      expect(onAny).not.toHaveBeenCalled();
      client.stop();
    });

    it("reconnects with backoff after the socket closes", () => {
      vi.useFakeTimers();
      try {
        const client = new GoLibrespotEventClient("ws://x/events", { WebSocketCtor: FakeWebSocket as any });
        client.start();
        expect(FakeWebSocket.instances).toHaveLength(1);

        FakeWebSocket.instances[0].emit("close");
        expect(FakeWebSocket.instances).toHaveLength(1); // not immediate
        vi.advanceTimersByTime(500);
        expect(FakeWebSocket.instances).toHaveLength(2); // reconnected
        client.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stop() closes the socket and prevents reconnect", () => {
      vi.useFakeTimers();
      try {
        const client = new GoLibrespotEventClient("ws://x/events", { WebSocketCtor: FakeWebSocket as any });
        client.start();
        const ws = FakeWebSocket.instances[0];
        client.stop();
        expect(ws.closed).toBe(true);
        vi.advanceTimersByTime(60000);
        expect(FakeWebSocket.instances).toHaveLength(1); // no new socket
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not throw on socket 'error' when no error listener is attached", () => {
      const client = new GoLibrespotEventClient("ws://x/events", { WebSocketCtor: FakeWebSocket as any });
      client.start();
      expect(() => FakeWebSocket.instances[0].emit("error", new Error("net"))).not.toThrow();
      client.stop();
    });
  });
  ```
  Add `beforeEach` to the vitest import at the top of the file:
  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";
  ```

  Verify (expect FAIL — `GoLibrespotEventClient` is not exported yet):
  ```
  npx vitest run src/music/spotify/go-librespot-api.test.ts
  ```

- [ ] **Step 4: Implement `GoLibrespotEventClient` (green).**
  Append to `src/music/spotify/go-librespot-api.ts` (the `EventEmitter`/`WebSocket` imports are already present from Step 2). Parses each `{type,data}` frame and re-emits `type` with `data`; reconnects on close with capped exponential backoff; `stop()` fences reconnects and closes. Guards `emit("error", …)` behind a listener count so a socket error with no listener does not crash the process.

  ```ts
  export type GoLibrespotEventType =
    | "metadata"
    | "playing"
    | "paused"
    | "not_playing"
    | "stopped"
    | "will_play"
    | "seek"
    | "active"
    | "inactive"
    | "volume"
    | "playback_ready";

  interface WsLike {
    on(event: string, cb: (...args: any[]) => void): void;
    close(): void;
  }
  type WebSocketCtor = new (url: string) => WsLike;

  const INITIAL_RECONNECT_MS = 500;
  const MAX_RECONNECT_MS = 10000;

  export class GoLibrespotEventClient extends EventEmitter {
    private wsUrl: string;
    private WebSocketCtor: WebSocketCtor;
    private ws: WsLike | null = null;
    private stopped = false;
    private reconnectDelay = INITIAL_RECONNECT_MS;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(wsUrl: string, deps?: { WebSocketCtor?: WebSocketCtor }) {
      super();
      this.wsUrl = wsUrl;
      this.WebSocketCtor = deps?.WebSocketCtor ?? (WebSocket as unknown as WebSocketCtor);
    }

    start(): void {
      this.stopped = false;
      this.connect();
    }

    stop(): void {
      this.stopped = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
    }

    private connect(): void {
      if (this.stopped) return;
      const ws = new this.WebSocketCtor(this.wsUrl);
      this.ws = ws;
      ws.on("open", () => {
        this.reconnectDelay = INITIAL_RECONNECT_MS;
      });
      ws.on("message", (buf: unknown) => this.handleMessage(buf));
      ws.on("close", () => {
        this.ws = null;
        this.scheduleReconnect();
      });
      ws.on("error", (err: unknown) => {
        if (this.listenerCount("error") > 0) this.emit("error", err);
      });
    }

    private handleMessage(buf: unknown): void {
      let parsed: unknown;
      try {
        const text = Buffer.isBuffer(buf)
          ? buf.toString("utf8")
          : typeof buf === "string"
            ? buf
            : String(buf);
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (parsed && typeof (parsed as any).type === "string") {
        this.emit((parsed as any).type, (parsed as any).data ?? {});
      }
    }

    private scheduleReconnect(): void {
      if (this.stopped || this.reconnectTimer) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_MS);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    }
  }
  ```

  Verify (expect PASS — all REST + WS tests green):
  ```
  npx vitest run src/music/spotify/go-librespot-api.test.ts
  ```

- [ ] **Step 5: Typecheck, full-suite sanity, and commit.**
  No existing files were modified (both files are new and additive), so existing tests are untouched. Confirm types and the whole suite, then commit.

  Verify (expect PASS / no type errors):
  ```
  npx tsc --noEmit
  npx vitest run src/music/spotify/go-librespot-api.test.ts
  ```
  Then commit:
  ```
  git add src/music/spotify/go-librespot-api.ts src/music/spotify/go-librespot-api.test.ts
  git commit -m "$(cat <<'EOF'
  feat(spotify): add go-librespot REST client + WS event client (Stage 2)

  GoLibrespotRestClient wraps axios (injectable via deps.http) for
  /player/play|pause|resume|stop|seek, GET /status, GET / ping; ping/getStatus
  swallow errors to false/null, mutating ops reject. GoLibrespotEventClient
  (EventEmitter) parses {type,data} /events frames and re-emits type with data,
  reconnects on close with capped backoff, stop() tears down. TDD with a mock
  AxiosInstance and a fake WebSocket (no real binary/network).

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 4: GoLibrespotBackend (process + ffmpeg + PCM + events)

**Files:**
- CREATE `src/music/spotify/go-librespot.ts`
- CREATE `src/music/spotify/go-librespot.test.ts`
- Depends on Tasks 1–3 already committed: `src/music/spotify/backend.ts` (interface), `src/music/spotify/binary.ts` (`findGoLibrespot`), `src/music/spotify/go-librespot-config.ts` (`renderConfigYml`), `src/music/spotify/go-librespot-api.ts` (`GoLibrespotRestClient`, `GoLibrespotEventClient`). This task does NOT touch `player.ts`/`instance.ts` (those are later tasks); their existing behavior is unaffected.

**Interfaces:**

Consumes (exact signatures from the locked contract):
- `renderConfigYml(o: GoLibrespotConfigOptions): string` where `GoLibrespotConfigOptions = { deviceName: string; bitrate: number; fifoPath: string; apiAddress: string; apiPort: number; callbackPort: number }`
- `findGoLibrespot(): string`
- `new GoLibrespotRestClient(baseUrl: string)` → `ping(): Promise<boolean>`, `playTrack(uri): Promise<void>`, `pause()/resume()/stop(): Promise<void>`, `seek(ms): Promise<void>`, `getStatus(): Promise<GoLibrespotStatus | null>`
- `new GoLibrespotEventClient(wsUrl: string)` (EventEmitter) → `start(): void`, `stop(): void`, emits `"metadata" | "not_playing" | "stopped" | "seek" | ...` with the parsed data object

Produces:
- `export interface GoLibrespotBackendOptions { deviceName: string; bitrate: number; workDir: string; configDir: string; apiPort?: number; logger: import("pino").Logger; deps?: any }`
- `export class GoLibrespotBackend extends EventEmitter implements SpotifyAudioBackend` — `start(): Promise<void>`, `stop(): void`, `isReady(): boolean`, `playTrack(uri): Promise<void>`, `pause()/resume(): Promise<void>`, `seek(ms): Promise<void>`, `getPcmStream(): Readable`, `getPositionMs(): number`, `on("trackEnded"|"metadata"|"ready"|"error", cb)`

---

- [ ] **Step 1: Write the failing test `src/music/spotify/go-librespot.test.ts`.** All external deps (child_process, fs, REST/WS clients, binary lookup, sleep) are injected so no real binary/FIFO/network is touched. Tests assert real behavior: spawn ORDER (mkfifo → ffmpeg → go-librespot), config written, WS `not_playing`/`stopped`/`metadata` mapping, REST delegation, PCM stream identity, and teardown.

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { GoLibrespotBackend } from "./go-librespot.js";

const log = pino({ level: "silent" });

/** A minimal stand-in for a spawned ChildProcess with real Readable stdout/stderr. */
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function makeHarness() {
  const calls: string[] = [];
  const ffmpegChild = makeFakeChild();
  const gliChild = makeFakeChild();

  const spawn = vi.fn((cmd: string) => {
    const isGli = cmd.includes("go-librespot");
    calls.push(`spawn:${isGli ? "go-librespot" : cmd}`);
    return isGli ? gliChild : ffmpegChild;
  });
  const execFileSync = vi.fn((cmd: string) => {
    calls.push(`exec:${cmd}`);
    return Buffer.from("");
  });
  const writeFileSync = vi.fn(() => calls.push("write:config"));
  const mkdirSync = vi.fn();
  const unlinkSync = vi.fn(() => calls.push("unlink:fifo"));
  const existsSync = vi.fn(() => false);

  const rest = {
    ping: vi.fn(async () => true),
    playTrack: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    getStatus: vi.fn(async () => null),
  };
  const events: any = new EventEmitter();
  events.start = vi.fn(() => calls.push("ws:start"));
  events.stop = vi.fn();

  const backend = new GoLibrespotBackend({
    deviceName: "Test Bot",
    bitrate: 320,
    workDir: "/tmp/work",
    configDir: "/tmp/cfg",
    apiPort: 3678,
    logger: log,
    deps: {
      spawn,
      execFileSync,
      writeFileSync,
      mkdirSync,
      unlinkSync,
      existsSync,
      findBinary: () => "/bin/go-librespot",
      makeRest: () => rest,
      makeEvents: () => events,
      sleep: async () => {},
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
    } as any,
  });

  return { backend, calls, spawn, execFileSync, writeFileSync, existsSync, unlinkSync, rest, events, ffmpegChild, gliChild };
}

describe("GoLibrespotBackend.start", () => {
  it("creates the FIFO with mkfifo before spawning ffmpeg, and spawns ffmpeg BEFORE go-librespot", async () => {
    const h = makeHarness();
    await h.backend.start();

    expect(h.execFileSync).toHaveBeenCalledWith("mkfifo", ["/tmp/work/go-librespot.fifo"]);
    expect(h.writeFileSync).toHaveBeenCalled();

    const mkfifoIdx = h.calls.indexOf("exec:mkfifo");
    const ffmpegIdx = h.calls.indexOf("spawn:ffmpeg");
    const gliIdx = h.calls.indexOf("spawn:go-librespot");
    expect(mkfifoIdx).toBeGreaterThanOrEqual(0);
    expect(ffmpegIdx).toBeGreaterThan(mkfifoIdx); // ffmpeg attaches to the FIFO first
    expect(gliIdx).toBeGreaterThan(ffmpegIdx);     // then the writer (go-librespot)
    expect(h.calls.indexOf("ws:start")).toBeGreaterThan(gliIdx); // WS connects last
  });

  it("passes --config_dir to go-librespot using the resolved binary path", async () => {
    const h = makeHarness();
    await h.backend.start();
    expect(h.spawn).toHaveBeenCalledWith(
      "/bin/go-librespot",
      ["--config_dir", "/tmp/cfg"],
      expect.anything(),
    );
  });

  it("uses the 44100->48000 s16le ffmpeg command reading the FIFO", async () => {
    const h = makeHarness();
    await h.backend.start();
    const ffmpegArgs = h.spawn.mock.calls.find((c) => c[0] === "ffmpeg")![1] as string[];
    expect(ffmpegArgs).toEqual([
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "/tmp/work/go-librespot.fifo",
      "-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "pipe:1",
    ]);
  });

  it("emits 'ready' and reports isReady() true once the REST ping succeeds", async () => {
    const h = makeHarness();
    const ready = vi.fn();
    h.backend.on("ready", ready);
    await h.backend.start();
    expect(h.rest.ping).toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(h.backend.isReady()).toBe(true);
  });

  it("keeps polling ping() until it returns true", async () => {
    const h = makeHarness();
    h.rest.ping.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    await h.backend.start();
    expect(h.rest.ping).toHaveBeenCalledTimes(3);
    expect(h.backend.isReady()).toBe(true);
  });
});

describe("GoLibrespotBackend WebSocket event mapping", () => {
  it("maps a not_playing event to trackEnded{reason:'ended'}", async () => {
    const h = makeHarness();
    await h.backend.start();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.events.emit("not_playing", { uri: "spotify:track:abc" });
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:abc", reason: "ended" });
  });

  it("maps a stopped event to trackEnded{reason:'stopped'}", async () => {
    const h = makeHarness();
    await h.backend.start();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.events.emit("stopped", { uri: "spotify:track:xyz" });
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:xyz", reason: "stopped" });
  });

  it("maps a metadata event to a SpotifyNowPlaying and updates getPositionMs()", async () => {
    const h = makeHarness();
    await h.backend.start();
    const meta = vi.fn();
    h.backend.on("metadata", meta);
    h.events.emit("metadata", {
      uri: "spotify:track:abc",
      name: "Song",
      artist_names: ["A", "B"],
      album_name: "Alb",
      album_cover_url: "http://x/y.jpg",
      position: 1234,
      duration: 200000,
    });
    expect(meta).toHaveBeenCalledWith({
      uri: "spotify:track:abc",
      name: "Song",
      artist: "A, B",
      album: "Alb",
      coverUrl: "http://x/y.jpg",
      durationMs: 200000,
    });
    expect(h.backend.getPositionMs()).toBe(1234);
  });
});

describe("GoLibrespotBackend transport delegation + PCM", () => {
  it("playTrack delegates to the REST client", async () => {
    const h = makeHarness();
    await h.backend.start();
    await h.backend.playTrack("spotify:track:go");
    expect(h.rest.playTrack).toHaveBeenCalledWith("spotify:track:go");
  });

  it("pause/resume/seek delegate to the REST client and seek updates position", async () => {
    const h = makeHarness();
    await h.backend.start();
    await h.backend.pause();
    await h.backend.resume();
    await h.backend.seek(5000);
    expect(h.rest.pause).toHaveBeenCalled();
    expect(h.rest.resume).toHaveBeenCalled();
    expect(h.rest.seek).toHaveBeenCalledWith(5000);
    expect(h.backend.getPositionMs()).toBe(5000);
  });

  it("getPcmStream() returns the ffmpeg stdout Readable", async () => {
    const h = makeHarness();
    await h.backend.start();
    expect(h.backend.getPcmStream()).toBe(h.ffmpegChild.stdout);
  });
});

describe("GoLibrespotBackend.stop", () => {
  it("kills ffmpeg + go-librespot, stops the WS, removes the FIFO, and clears ready", async () => {
    const h = makeHarness();
    await h.backend.start();
    h.existsSync.mockReturnValue(true); // FIFO now present, so stop() unlinks it
    h.backend.stop();
    expect(h.ffmpegChild.kill).toHaveBeenCalled();
    expect(h.gliChild.kill).toHaveBeenCalled();
    expect(h.events.stop).toHaveBeenCalled();
    expect(h.unlinkSync).toHaveBeenCalledWith("/tmp/work/go-librespot.fifo");
    expect(h.backend.isReady()).toBe(false);
  });
});
```

Verify (expect FAIL — module not implemented yet):
`npx vitest run src/music/spotify/go-librespot.test.ts`

- [ ] **Step 2: Implement `src/music/spotify/go-librespot.ts` to make the tests pass.** ESM `.js` import specifiers throughout. Deps default to the real Node modules; every branch the tests exercise is overridable via `options.deps`.

```ts
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  execFileSync as realExecFileSync,
  spawn as realSpawn,
} from "node:child_process";
import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  unlinkSync as realUnlinkSync,
  writeFileSync as realWriteFileSync,
} from "node:fs";
import type { Logger } from "pino";
import type {
  SpotifyAudioBackend,
  SpotifyTrackEndedEvent,
  SpotifyNowPlaying,
} from "./backend.js";
import { findGoLibrespot } from "./binary.js";
import { renderConfigYml } from "./go-librespot-config.js";
import { GoLibrespotRestClient, GoLibrespotEventClient } from "./go-librespot-api.js";

export interface GoLibrespotBackendOptions {
  deviceName: string;
  bitrate: number;
  workDir: string;
  configDir: string;
  apiPort?: number;
  logger: Logger;
  deps?: GoLibrespotBackendDeps;
}

/** Injectable seams so the whole lifecycle is testable without a real binary/FIFO/network. */
export interface GoLibrespotBackendDeps {
  spawn?: typeof realSpawn;
  execFileSync?: typeof realExecFileSync;
  existsSync?: typeof realExistsSync;
  mkdirSync?: typeof realMkdirSync;
  unlinkSync?: typeof realUnlinkSync;
  writeFileSync?: typeof realWriteFileSync;
  findBinary?: () => string;
  makeRest?: (baseUrl: string) => GoLibrespotRestClient;
  makeEvents?: (wsUrl: string) => GoLibrespotEventClient;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

const DEFAULT_API_PORT = 3678;
const DEFAULT_CALLBACK_PORT = 8080;
const FIFO_NAME = "go-librespot.fifo";

export class GoLibrespotBackend extends EventEmitter implements SpotifyAudioBackend {
  private readonly opts: GoLibrespotBackendOptions;
  private readonly log: Logger;
  private readonly deps: GoLibrespotBackendDeps;
  private readonly apiPort: number;
  private readonly fifoPath: string;

  private ffmpeg: ChildProcess | null = null;
  private proc: ChildProcess | null = null;
  private rest: GoLibrespotRestClient | null = null;
  private events: GoLibrespotEventClient | null = null;
  private ready = false;
  private positionMs = 0;

  constructor(o: GoLibrespotBackendOptions) {
    super();
    this.opts = o;
    this.log = o.logger;
    this.deps = o.deps ?? {};
    this.apiPort = o.apiPort ?? DEFAULT_API_PORT;
    this.fifoPath = join(o.workDir, FIFO_NAME);
  }

  async start(): Promise<void> {
    const spawn = this.deps.spawn ?? realSpawn;
    const execFileSync = this.deps.execFileSync ?? realExecFileSync;
    const existsSync = this.deps.existsSync ?? realExistsSync;
    const mkdirSync = this.deps.mkdirSync ?? realMkdirSync;
    const unlinkSync = this.deps.unlinkSync ?? realUnlinkSync;
    const writeFileSync = this.deps.writeFileSync ?? realWriteFileSync;
    const findBinary = this.deps.findBinary ?? findGoLibrespot;

    // 1. Ensure work + config directories exist.
    mkdirSync(this.opts.workDir, { recursive: true });
    mkdirSync(this.opts.configDir, { recursive: true });

    // 2. (Re)create the FIFO — mkfifo fails if the path already exists.
    if (existsSync(this.fifoPath)) unlinkSync(this.fifoPath);
    execFileSync("mkfifo", [this.fifoPath]);

    // 3. Spawn ffmpeg FIRST so the PCM reader is attached to the FIFO before
    //    go-librespot (the writer) starts pushing raw 44.1k s16le into it.
    this.ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", this.fifoPath,
        "-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.ffmpeg.stderr?.on("data", (b: Buffer) =>
      this.log.debug({ ffmpeg: b.toString().trim() }, "ffmpeg"),
    );
    this.ffmpeg.on("error", (err) => this.emit("error", err));

    // 4. Render + write config.yml into the config dir.
    const yml = renderConfigYml({
      deviceName: this.opts.deviceName,
      bitrate: this.opts.bitrate,
      fifoPath: this.fifoPath,
      apiAddress: "0.0.0.0",
      apiPort: this.apiPort,
      callbackPort: DEFAULT_CALLBACK_PORT,
    });
    writeFileSync(join(this.opts.configDir, "config.yml"), yml, "utf8");

    // 5. Spawn go-librespot AFTER ffmpeg is listening on the FIFO. Its stdout/
    //    stderr carry the interactive OAuth URL on first run — surface via logger.
    const bin = findBinary();
    this.proc = spawn(bin, ["--config_dir", this.opts.configDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onLog = (b: Buffer) => this.log.info({ golibrespot: b.toString().trim() }, "go-librespot");
    this.proc.stdout?.on("data", onLog);
    this.proc.stderr?.on("data", onLog);
    this.proc.on("error", (err) => this.emit("error", err));
    this.proc.on("exit", (code, signal) => {
      this.ready = false;
      this.log.warn({ code, signal }, "go-librespot exited");
    });

    // 6. REST client, then poll GET / until the HTTP server answers.
    const baseUrl = `http://127.0.0.1:${this.apiPort}`;
    this.rest = this.deps.makeRest
      ? this.deps.makeRest(baseUrl)
      : new GoLibrespotRestClient(baseUrl);
    await this.waitUntilReady();

    // 7. Connect the WebSocket event stream and wire event mapping.
    const wsUrl = `ws://127.0.0.1:${this.apiPort}/events`;
    this.events = this.deps.makeEvents
      ? this.deps.makeEvents(wsUrl)
      : new GoLibrespotEventClient(wsUrl);
    this.wireEvents(this.events);
    this.events.start();

    this.ready = true;
    this.emit("ready");
  }

  private async waitUntilReady(): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const interval = this.deps.pollIntervalMs ?? 200;
    const timeout = this.deps.pollTimeoutMs ?? 15_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.rest && (await this.rest.ping())) return;
      await sleep(interval);
    }
    throw new Error("go-librespot API did not become ready within timeout");
  }

  private wireEvents(ev: GoLibrespotEventClient): void {
    ev.on("metadata", (d: any) => {
      const np: SpotifyNowPlaying = {
        uri: typeof d?.uri === "string" ? d.uri : "",
        name: typeof d?.name === "string" ? d.name : "",
        artist: Array.isArray(d?.artist_names) ? d.artist_names.join(", ") : "",
        album: typeof d?.album_name === "string" ? d.album_name : "",
        coverUrl: typeof d?.album_cover_url === "string" ? d.album_cover_url : "",
        durationMs: typeof d?.duration === "number" ? d.duration : 0,
      };
      if (typeof d?.position === "number") this.positionMs = d.position;
      this.emit("metadata", np);
    });
    ev.on("seek", (d: any) => {
      if (typeof d?.position === "number") this.positionMs = d.position;
    });
    ev.on("not_playing", (d: any) => {
      const e: SpotifyTrackEndedEvent = { uri: typeof d?.uri === "string" ? d.uri : "", reason: "ended" };
      this.emit("trackEnded", e);
    });
    ev.on("stopped", (d: any) => {
      const e: SpotifyTrackEndedEvent = { uri: typeof d?.uri === "string" ? d.uri : "", reason: "stopped" };
      this.emit("trackEnded", e);
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  async playTrack(uri: string): Promise<void> {
    if (!this.rest) throw new Error("go-librespot backend not started");
    await this.rest.playTrack(uri);
  }

  async pause(): Promise<void> {
    if (this.rest) await this.rest.pause();
  }

  async resume(): Promise<void> {
    if (this.rest) await this.rest.resume();
  }

  async seek(ms: number): Promise<void> {
    if (this.rest) await this.rest.seek(ms);
    this.positionMs = ms;
  }

  getPcmStream(): Readable {
    const out = this.ffmpeg?.stdout;
    if (!out) throw new Error("PCM stream unavailable (go-librespot backend not started)");
    return out;
  }

  getPositionMs(): number {
    return this.positionMs;
  }

  stop(): void {
    this.ready = false;
    try {
      this.events?.stop();
    } catch {
      /* ignore */
    }
    this.events = null;
    this.rest = null;
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    if (this.ffmpeg) {
      try {
        this.ffmpeg.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.ffmpeg = null;
    }
    const existsSync = this.deps.existsSync ?? realExistsSync;
    const unlinkSync = this.deps.unlinkSync ?? realUnlinkSync;
    try {
      if (existsSync(this.fifoPath)) unlinkSync(this.fifoPath);
    } catch {
      /* ignore */
    }
  }
}
```

Verify (expect PASS — all specs green):
`npx vitest run src/music/spotify/go-librespot.test.ts`

- [ ] **Step 3: Typecheck the whole project.** `GoLibrespotBackend` must structurally satisfy `SpotifyAudioBackend` (EventEmitter's `on(): this` is assignable where the interface expects `on(): void`).

Verify (expect PASS — no type errors):
`npx tsc --noEmit`

- [ ] **Step 4: Commit.**

```bash
git add src/music/spotify/go-librespot.ts src/music/spotify/go-librespot.test.ts
git commit -m "$(cat <<'EOF'
feat(spotify): GoLibrespotBackend sidecar (FIFO + ffmpeg PCM + REST/WS)

Implements SpotifyAudioBackend over a go-librespot sidecar: start() mkfifos
the pipe, spawns the FIFO->48k s16le ffmpeg reader BEFORE go-librespot, writes
config.yml, polls the REST /  until ready, then connects the WS event stream.
Maps not_playing/stopped -> trackEnded and metadata -> SpotifyNowPlaying;
play/pause/resume/seek delegate to the REST client. All child_process/fs/REST/WS
seams are injectable so the lifecycle is fully unit-tested without a real binary.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> **Note (report):** Live Spotify audio is NOT exercised by these tests — it requires a Spotify Premium account, an interactive OAuth login, and a Linux host with `mkfifo` + the `go-librespot` binary. The unit tests verify orchestration only (spawn order, config/FIFO creation, WS→event mapping, REST delegation, PCM stream wiring, teardown) with every OS/network dependency injected. End-to-end audio validation is deferred to the Linux/Docker manual-QA stage.

---

### Task 5: AudioPlayer external-PCM mode (playPcmStream)

**Files:**
- MODIFY `src/audio/player.ts` — add external-PCM mode (new fields, `playPcmStream()`, external-aware frame loop / `sendNextFrame` / `stop` / `seek`). The existing url `play(url)` path, `playViaPowerShellDownload`, `spawnFfmpegFromFile`, and all exported pure functions (`buildFfmpegArgs`, `shouldEndOnStall`, `volumeToFactor`, `shouldUsePowerShellDownload`, `cleanupTempDir`) stay **100% unchanged**.
- ADD tests to `src/audio/player.test.ts` — new `describe("AudioPlayer external-PCM mode (playPcmStream)")` block; the existing `describe` blocks (buildFfmpegArgs / volumeToFactor / shouldUsePowerShellDownload / cleanupTempDir / shouldEndOnStall) are left untouched and must keep passing.

**Interfaces:**

Consumes (existing, verbatim):
- `import { Readable } from "node:stream"` — the external PCM source (contract: `getPcmStream(): import("node:stream").Readable`).
- `PCM_FRAME_BYTES = 3840`, `Encoder.encode(pcm: Buffer): Buffer` from `./encoder.js` (already imported in player.ts).
- `AudioPlayer` reuses its own `pcmBuffer`, `sessionId`, `startFrameLoop()`, `scheduleNextFrame()`, `sendNextFrame()`, `applyVolume()`, `stop()`, `PlayerEvents` (`"frame" | "trackEnd" | "error"`), `BUFFER_HIGH_WATER`/`BUFFER_LOW_WATER`.

Produces (new public API — matches the locked player.ts contract):
- `playPcmStream(readable: import("node:stream").Readable, opts: { onExternalEnd?: () => void }): void`
  - fences via `stop()` (bumps `sessionId`), sets internal `externalMode = true`, does NOT spawn ffmpeg, feeds `pcmBuffer` from `readable "data"` under the `sessionId` guard with the SAME high/low-water backpressure (pausing/resuming the Readable), `state = "playing"`, `startFrameLoop()`; suppresses the underrun `trackEnd` drain/stall branches while `externalMode` (emits a silence frame instead); `stop()` tears down `externalMode`; `seek()` is a local no-op while `externalMode`.

---

- [ ] **Step 1: Write the RED tests (feed a fake Readable, assert real behavior).**
  Append this block to `src/audio/player.test.ts`. It constructs a real `AudioPlayer` (the real `@discordjs/opus` encoder already loads via the existing `import ... from "./player.js"`, so `"frame"` events carry real Opus buffers) and drives a controllable `Readable`.

  ```ts
  import { Readable } from "node:stream";
  import { AudioPlayer } from "./player.js";
  import type { Logger } from "../logger.js";

  // Minimal stub: AudioPlayer only calls debug/info/warn/error; child() returns self.
  const silentLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    trace() {},
    child() {
      return silentLogger;
    },
  } as unknown as Logger;

  // A readable we fully control: no underlying source; we push PCM manually and
  // keep it open (never push(null)) to model the long-lived go-librespot sidecar.
  function openPcmReadable(): Readable {
    return new Readable({ read() {} });
  }

  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const FRAME_BYTES = 3840; // PCM_FRAME_BYTES: 960 samples * 2ch * 2 bytes @48k s16le

  describe("AudioPlayer external-PCM mode (playPcmStream)", () => {
    it("emits Opus 'frame' events from the external PCM stream without spawning ffmpeg", async () => {
      const player = new AudioPlayer(silentLogger);
      const frames: Buffer[] = [];
      player.on("frame", (f) => frames.push(f));

      const stream = openPcmReadable();
      player.playPcmStream(stream, {});
      stream.push(Buffer.alloc(FRAME_BYTES * 10)); // ~10 frames of PCM

      await wait(150); // ~7 frame ticks at 20ms

      expect(player.getState()).toBe("playing");
      expect(frames.length).toBeGreaterThan(0);
      expect(Buffer.isBuffer(frames[0])).toBe(true);
      player.stop();
    });

    it("does NOT emit 'trackEnd' on underrun while external (stream stays open)", async () => {
      const player = new AudioPlayer(silentLogger);
      let ended = 0;
      const frames: Buffer[] = [];
      player.on("trackEnd", () => ended++);
      player.on("frame", (f) => frames.push(f));

      const stream = openPcmReadable();
      player.playPcmStream(stream, {});
      stream.push(Buffer.alloc(FRAME_BYTES * 2)); // only 2 frames, then underrun

      await wait(200); // long after those 2 frames have drained

      // In the url path, ffmpeg===null + empty buffer would fire trackEnd; here it must not.
      expect(ended).toBe(0);
      // Silence frames keep the 20ms timeline alive -> more than the 2 fed frames emitted.
      expect(frames.length).toBeGreaterThan(2);
      expect(player.getState()).toBe("playing");
      player.stop();
    });

    it("stop() tears down external mode, fences via sessionId, and destroys the readable", async () => {
      const player = new AudioPlayer(silentLogger);
      const frames: Buffer[] = [];
      player.on("frame", (f) => frames.push(f));

      const stream = openPcmReadable();
      player.playPcmStream(stream, {});
      stream.push(Buffer.alloc(FRAME_BYTES * 5));
      await wait(80);

      player.stop();
      expect(player.getState()).toBe("idle");
      expect(stream.destroyed).toBe(true);

      const countAtStop = frames.length;
      // sessionId fence: PCM pushed after stop must not resurrect the timeline.
      try {
        stream.push(Buffer.alloc(FRAME_BYTES * 5));
      } catch {
        /* readable already destroyed */
      }
      await wait(80);
      expect(frames.length).toBe(countAtStop);
    });

    it("fires onExternalEnd when the readable ends (drives controller-based advance)", async () => {
      const player = new AudioPlayer(silentLogger);
      let endedCb = 0;

      const stream = openPcmReadable();
      player.playPcmStream(stream, { onExternalEnd: () => endedCb++ });
      stream.push(Buffer.alloc(FRAME_BYTES));
      await wait(40);
      stream.push(null); // end-of-stream
      await wait(40);

      expect(endedCb).toBe(1);
      player.stop();
    });

    it("seek() is a local no-op in external mode (never respawns ffmpeg on a spotify sentinel)", async () => {
      const player = new AudioPlayer(silentLogger);
      const stream = openPcmReadable();
      player.playPcmStream(stream, {});
      stream.push(Buffer.alloc(FRAME_BYTES * 3));
      await wait(40);

      expect(() => player.seek(30)).not.toThrow();
      // Still external, still playing — no url-ffmpeg respawn, state unchanged.
      expect(player.getState()).toBe("playing");
      player.stop();
    });

    it("pause()/resume() still gate local emission in external mode (unchanged semantics)", async () => {
      const player = new AudioPlayer(silentLogger);
      const stream = openPcmReadable();
      player.playPcmStream(stream, {});
      stream.push(Buffer.alloc(FRAME_BYTES * 3));
      await wait(40);

      player.pause();
      expect(player.getState()).toBe("paused");
      player.resume();
      expect(player.getState()).toBe("playing");
      player.stop();
    });
  });
  ```

  Verify (RED): `npx vitest run src/audio/player.test.ts` → the new block **FAILS** (TypeScript: `Property 'playPcmStream' does not exist on type 'AudioPlayer'`; the 5 existing describe blocks still pass).

- [ ] **Step 2: Add the external-mode fields + `Readable` type import to `src/audio/player.ts`.**
  Add a type-only import near the top (player.ts never constructs a `Readable`, only annotates one):

  ```ts
  import type { Readable } from "node:stream";
  ```

  Then add three fields immediately after `private currentSongDuration = 0;` (line 188):

  ```ts
    // --- External PCM mode (Stage 2: go-librespot Spotify sidecar) ---
    // When true, PCM arrives from a long-lived external Readable instead of a
    // per-URL ffmpeg: this.ffmpeg stays null, and the underrun-driven trackEnd
    // branches are suppressed (advance is driven by the controller, not EOF).
    private externalMode = false;
    private externalStream: Readable | null = null;
    private onExternalEnd: (() => void) | null = null;
  ```

- [ ] **Step 3: Implement `playPcmStream()` in `src/audio/player.ts`.**
  Insert this method between the end of `spawnFfmpegFromFile()` (line 391, `this.startFrameLoop(); }`) and `stop()` (line 393). It mirrors `play()`'s state-reset + sessionId-guarded ingestion but skips ffmpeg entirely.

  ```ts
    /**
     * External-PCM mode (Stage 2 go-librespot Spotify sidecar).
     *
     * Feeds an already-normalized 48kHz/s16le/stereo PCM Readable (the
     * go-librespot FIFO -> ffmpeg output) straight into the existing pcmBuffer +
     * 20ms frame loop + Opus encoder + "frame" emission, WITHOUT spawning a
     * per-URL ffmpeg. The url play() path is left completely untouched.
     *
     * Track advance is NOT driven by buffer underrun here (the sidecar stream is
     * continuous and never EOFs per song); the caller drives advance via the
     * SpotifyController "trackEnded" WebSocket event. onExternalEnd fires only if
     * the underlying readable itself ends or errors.
     */
    playPcmStream(readable: Readable, opts: { onExternalEnd?: () => void } = {}): void {
      // 1. Fence current playback: stop() bumps sessionId, clears pcmBuffer, kills
      //    any ffmpeg, and tears down any prior external stream.
      this.stop();

      const currentSessionId = this.sessionId;
      this.externalMode = true;
      this.externalStream = readable;
      this.onExternalEnd = opts.onExternalEnd ?? null;
      // Leave this.ffmpeg = null; clear currentUrl so seek() cannot respawn ffmpeg.
      this.currentUrl = "";
      this.seekOffset = 0;
      this.framesPlayed = 0;
      this.healthyFrames = 0;
      this.ffmpegPaused = false;
      this.spawnFailed = false;
      this.emptyFrameAttempts = 0;
      this.currentSongDuration = 0;

      // Same ingestion + high-water backpressure as the ffmpeg.stdout handler,
      // but pausing the Readable instead of ffmpeg.stdout. sessionId-guarded so
      // stale sidecar PCM can't leak into a new track after stop()/skip.
      readable.on("data", (chunk: Buffer) => {
        if (this.sessionId !== currentSessionId) return;
        this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);
        if (
          this.pcmBuffer.length > AudioPlayer.BUFFER_HIGH_WATER &&
          !this.ffmpegPaused &&
          this.externalStream === readable
        ) {
          readable.pause();
          this.ffmpegPaused = true;
        }
      });

      readable.on("end", () => {
        if (this.sessionId !== currentSessionId) return;
        this.onExternalEnd?.();
      });
      readable.on("error", (err) => {
        if (this.sessionId !== currentSessionId) return;
        this.logger.warn({ err }, "External PCM stream error");
        this.onExternalEnd?.();
      });

      this.state = "playing";
      this.startFrameLoop();
    }
  ```

- [ ] **Step 4: Suppress the two underrun `trackEnd` drain/stall branches while `externalMode`.**
  Gate both branches in `scheduleNextFrame()` behind `!this.externalMode` so a continuous stream's transient underrun never ends the track (Branch B at line 529 would otherwise fire instantly because `this.ffmpeg === null`).

  Branch A (line 483) — replace:
  ```ts
        if (this.ffmpeg !== null && this.pcmBuffer.length < PCM_FRAME_BYTES) {
  ```
  with:
  ```ts
        if (!this.externalMode && this.ffmpeg !== null && this.pcmBuffer.length < PCM_FRAME_BYTES) {
  ```

  Branch B (line 529) — replace:
  ```ts
        if (!this.ffmpeg && this.pcmBuffer.length < PCM_FRAME_BYTES) {
  ```
  with:
  ```ts
        if (!this.externalMode && !this.ffmpeg && this.pcmBuffer.length < PCM_FRAME_BYTES) {
  ```

  In external mode both branches are skipped; the `else` at line 524 still resets `emptyFrameAttempts`, and `scheduleNextFrame()` reschedules indefinitely while `frameLoopRunning`. The url path (externalMode=false) is behaviorally identical.

- [ ] **Step 5: Make `sendNextFrame()` external-aware (silence on underrun + resume the Readable) and add `emitSilenceFrame()`.**
  In `sendNextFrame()` (line 544), replace the early return:
  ```ts
    private sendNextFrame(): void {
      if (this.pcmBuffer.length < PCM_FRAME_BYTES) return;
  ```
  with:
  ```ts
    private sendNextFrame(): void {
      if (this.pcmBuffer.length < PCM_FRAME_BYTES) {
        // External mode: the sidecar PCM stream is long-lived and must NOT end on
        // a transient underrun. Emit an encoded silence frame so the 20ms voice
        // timeline stays continuous instead of returning (which would desync TS).
        if (this.externalMode) this.emitSilenceFrame();
        return;
      }
  ```

  Replace the low-water resume block (lines 549-552):
  ```ts
      if (this.ffmpegPaused && this.pcmBuffer.length < AudioPlayer.BUFFER_LOW_WATER && this.ffmpeg?.stdout) {
        this.ffmpeg.stdout.resume();
        this.ffmpegPaused = false;
      }
  ```
  with:
  ```ts
      if (this.ffmpegPaused && this.pcmBuffer.length < AudioPlayer.BUFFER_LOW_WATER) {
        if (this.externalMode && this.externalStream) {
          this.externalStream.resume();
          this.ffmpegPaused = false;
        } else if (this.ffmpeg?.stdout) {
          this.ffmpeg.stdout.resume();
          this.ffmpegPaused = false;
        }
      }
  ```

  Add the helper immediately after `sendNextFrame()` closes (before `applyVolume`, line 569):
  ```ts
    private emitSilenceFrame(): void {
      try {
        const opusFrame = this.encoder.encode(Buffer.alloc(PCM_FRAME_BYTES));
        this.emit("frame", opusFrame);
        this.framesPlayed++;
      } catch (err) {
        this.emit("error", err as Error);
      }
    }
  ```

- [ ] **Step 6: Extend `stop()` teardown and make `seek()` a no-op in external mode.**
  In `stop()`, insert the external teardown just before `this.ffmpegPaused = false;` (line 422). `sessionId++` (already at the top of stop) fences the external `"data"`/`"end"`/`"error"` handlers; destroying the readable stops the sidecar PCM at the source.

  ```ts
      if (this.externalStream) {
        const stream = this.externalStream;
        this.externalStream = null;
        try {
          stream.destroy();
        } catch {
          /* best-effort */
        }
      }
      this.externalMode = false;
      this.onExternalEnd = null;

      this.ffmpegPaused = false;
  ```

  Replace `seek()` (lines 582-586):
  ```ts
    seek(seconds: number): void { 
      if (this.currentUrl && Number.isFinite(seconds) && seconds >= 0) {
        this.play(this.currentUrl, seconds, this.currentSongDuration);
      }
    }
  ```
  with:
  ```ts
    seek(seconds: number): void {
      // External (Spotify sidecar) mode: local seek is a no-op. Respawning ffmpeg
      // on the spotify: sentinel would collide with the continuous PCM source;
      // transport is delegated to the SpotifyController by the caller.
      if (this.externalMode) return;
      if (this.currentUrl && Number.isFinite(seconds) && seconds >= 0) {
        this.play(this.currentUrl, seconds, this.currentSongDuration);
      }
    }
  ```

  `pause()`/`resume()` (lines 587-588) are intentionally left unchanged — they only flip `state`, which already gates local frame emission for both modes (the real transport pause is delegated to the controller by the instance layer in a later task).

- [ ] **Step 7: Verify GREEN + types.**
  - `npx vitest run src/audio/player.test.ts` → **all** tests pass: the 6 new external-mode tests AND the 5 pre-existing describe blocks (buildFfmpegArgs / volumeToFactor / shouldUsePowerShellDownload / cleanupTempDir / shouldEndOnStall) — confirming the url `play()` path is unchanged.
  - `npx tsc --noEmit` → passes with no errors (no new type errors from the `Readable` import, the new fields, or the `playPcmStream` signature).

- [ ] **Step 8: Commit.**
  ```bash
  git add src/audio/player.ts src/audio/player.test.ts
  git commit -m "$(cat <<'EOF'
  feat(audio): add external-PCM mode (playPcmStream) for Spotify sidecar

  Adds AudioPlayer.playPcmStream(readable, {onExternalEnd}) that feeds a
  long-lived external 48kHz/s16le/stereo Readable into the existing pcmBuffer +
  20ms frame loop + Opus encoder without spawning a per-URL ffmpeg. Reuses the
  same high/low-water backpressure (pausing/resuming the Readable), suppresses the
  underrun trackEnd drain/stall branches while external (emitting a silence frame
  to keep the 20ms timeline), tears down externalMode in stop() (destroy readable,
  clear onExternalEnd) and makes seek() a local no-op in external mode. The url
  play() path and all exported pure functions are unchanged.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 6: SpotifyController (backend lifecycle + gating + events)

**Files:**
- CREATE `src/music/spotify/controller.ts`
- CREATE `src/music/spotify/controller.test.ts`

**Interfaces:**

Consumes:
- `interface SpotifyConfig { enabled: boolean; backend: "auto"|"go-librespot"|"librespot"; clientId: string; clientSecret: string; deviceName: string; bitrate: number }` — `../../data/config.js`
- `isGoLibrespotSupported(): boolean` and `findGoLibrespot(): string` — `./binary.js`
- `interface SpotifyAudioBackend { start(): Promise<void>; stop(): void; isReady(): boolean; playTrack(uri: string): Promise<void>; pause(): Promise<void>; resume(): Promise<void>; seek(ms: number): Promise<void>; getPcmStream(): Readable; getPositionMs(): number; on(...) }`, `interface SpotifyTrackEndedEvent { uri: string; reason: "ended"|"stopped"|"error" }`, `interface SpotifyNowPlaying { uri; name; artist; album; coverUrl; durationMs }` — `./backend.js`
- `class GoLibrespotBackend implements SpotifyAudioBackend` (default factory only) — `./go-librespot.js`

Produces:
- `class SpotifyController extends EventEmitter`
  - `constructor(o: { config: SpotifyConfig; workDir: string; configDir: string; logger: import("pino").Logger; backendFactory?: () => SpotifyAudioBackend })`
  - `isAvailable(): boolean` — `config.enabled && isGoLibrespotSupported() && existsSync(findGoLibrespot())`
  - `ensureStarted(): Promise<boolean>` — idempotent; `false` if unavailable or start throws
  - `playTrack(uri: string): Promise<boolean>` — ensureStarted + `backend.playTrack`; `false` on failure
  - `pause(): Promise<void>`, `resume(): Promise<void>`, `seek(ms: number): Promise<void>`, `stop(): void`
  - `getPcmStream(): import("node:stream").Readable`
  - re-emits backend `"trackEnded"(SpotifyTrackEndedEvent)` and `"metadata"(SpotifyNowPlaying)`

---

- [ ] **Step 1: Write the failing test (`src/music/spotify/controller.test.ts`).**
  Mock `./binary.js` with `vi.hoisted` state so availability is controllable without a real Linux binary. Point `findGoLibrespot()` at a real temp file so `existsSync` is exercised for real (no `node:fs` mock). Use a fake backend (a real `EventEmitter` with call counters) so assertions check real delegation/re-emission, not mock identity.

  ```ts
  import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
  import { EventEmitter } from "node:events";
  import { Readable } from "node:stream";
  import { writeFileSync, rmSync } from "node:fs";
  import { join } from "node:path";
  import { tmpdir } from "node:os";
  import type { Logger } from "pino";
  import type { SpotifyConfig } from "../../data/config.js";
  import type {
    SpotifyAudioBackend,
    SpotifyTrackEndedEvent,
    SpotifyNowPlaying,
  } from "./backend.js";

  // Controllable, hoisted so the vi.mock factory can close over it.
  const bin = vi.hoisted(() => ({ supported: true, path: "" }));
  vi.mock("./binary.js", () => ({
    isGoLibrespotSupported: () => bin.supported,
    findGoLibrespot: () => bin.path,
    resetGoLibrespotBinaryCache: () => {},
    checkGoLibrespotAvailable: async () => bin.supported && !!bin.path,
  }));

  // Import AFTER vi.mock so the mocked binary module is used.
  const { SpotifyController } = await import("./controller.js");

  const existingBin = join(tmpdir(), `tsmb-golibrespot-${process.pid}`);
  const missingBin = join(tmpdir(), `tsmb-golibrespot-missing-${process.pid}`);

  beforeAll(() => {
    writeFileSync(existingBin, "#!/bin/sh\n");
  });
  afterAll(() => {
    try {
      rmSync(existingBin);
    } catch {
      /* ignore */
    }
  });
  beforeEach(() => {
    bin.supported = true;
    bin.path = existingBin;
  });

  class FakeBackend extends EventEmitter implements SpotifyAudioBackend {
    startCalls = 0;
    stopCalls = 0;
    playCalls: string[] = [];
    pauseCalls = 0;
    resumeCalls = 0;
    seekCalls: number[] = [];
    ready = false;
    startShouldReject = false;
    playShouldReject = false;
    readonly pcm = Readable.from([Buffer.alloc(0)]);

    async start(): Promise<void> {
      this.startCalls++;
      if (this.startShouldReject) throw new Error("start boom");
      this.ready = true;
    }
    stop(): void {
      this.stopCalls++;
      this.ready = false;
    }
    isReady(): boolean {
      return this.ready;
    }
    async playTrack(uri: string): Promise<void> {
      this.playCalls.push(uri);
      if (this.playShouldReject) throw new Error("play boom");
    }
    async pause(): Promise<void> {
      this.pauseCalls++;
    }
    async resume(): Promise<void> {
      this.resumeCalls++;
    }
    async seek(ms: number): Promise<void> {
      this.seekCalls.push(ms);
    }
    getPcmStream(): Readable {
      return this.pcm;
    }
    getPositionMs(): number {
      return 0;
    }
  }

  const silentLogger = {
    info() {},
    error() {},
    warn() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return silentLogger;
    },
  } as unknown as Logger;

  function cfg(over: Partial<SpotifyConfig> = {}): SpotifyConfig {
    return {
      enabled: true,
      backend: "auto",
      clientId: "",
      clientSecret: "",
      deviceName: "TSMusicBot",
      bitrate: 320,
      ...over,
    };
  }

  function makeCtrl(over: {
    config?: Partial<SpotifyConfig>;
    backendFactory?: () => SpotifyAudioBackend;
  } = {}) {
    const be = new FakeBackend();
    const ctrl = new SpotifyController({
      config: cfg(over.config),
      workDir: "/tmp/work",
      configDir: "/tmp/cfg",
      logger: silentLogger,
      backendFactory: over.backendFactory ?? (() => be),
    });
    return { ctrl, be };
  }

  describe("SpotifyController.isAvailable", () => {
    it("true when enabled + supported + binary present", () => {
      const { ctrl } = makeCtrl();
      expect(ctrl.isAvailable()).toBe(true);
    });
    it("false when config disabled", () => {
      const { ctrl } = makeCtrl({ config: { enabled: false } });
      expect(ctrl.isAvailable()).toBe(false);
    });
    it("false when platform unsupported", () => {
      bin.supported = false;
      const { ctrl } = makeCtrl();
      expect(ctrl.isAvailable()).toBe(false);
    });
    it("false when binary file is absent", () => {
      bin.path = missingBin;
      const { ctrl } = makeCtrl();
      expect(ctrl.isAvailable()).toBe(false);
    });
  });

  describe("SpotifyController.ensureStarted", () => {
    it("starts the backend exactly once across repeated calls", async () => {
      let built = 0;
      const be = new FakeBackend();
      const { ctrl } = makeCtrl({
        backendFactory: () => {
          built++;
          return be;
        },
      });
      expect(await ctrl.ensureStarted()).toBe(true);
      expect(await ctrl.ensureStarted()).toBe(true);
      expect(built).toBe(1);
      expect(be.startCalls).toBe(1);
    });

    it("is idempotent under concurrent calls (single start)", async () => {
      let built = 0;
      const be = new FakeBackend();
      const { ctrl } = makeCtrl({
        backendFactory: () => {
          built++;
          return be;
        },
      });
      const [a, b] = await Promise.all([ctrl.ensureStarted(), ctrl.ensureStarted()]);
      expect(a).toBe(true);
      expect(b).toBe(true);
      expect(built).toBe(1);
      expect(be.startCalls).toBe(1);
    });

    it("returns false and does not build a backend when unavailable", async () => {
      let built = 0;
      const { ctrl } = makeCtrl({
        config: { enabled: false },
        backendFactory: () => {
          built++;
          return new FakeBackend();
        },
      });
      expect(await ctrl.ensureStarted()).toBe(false);
      expect(built).toBe(0);
    });

    it("returns false when backend.start() throws, and allows a later retry", async () => {
      const be = new FakeBackend();
      be.startShouldReject = true;
      let built = 0;
      const { ctrl } = makeCtrl({
        backendFactory: () => {
          built++;
          return be;
        },
      });
      expect(await ctrl.ensureStarted()).toBe(false);
      // start failure clears the cached promise so a subsequent call retries.
      be.startShouldReject = false;
      expect(await ctrl.ensureStarted()).toBe(true);
      expect(built).toBe(2);
      expect(be.startCalls).toBe(2);
    });
  });

  describe("SpotifyController.playTrack", () => {
    it("ensures started then delegates the uri, returning true", async () => {
      const { ctrl, be } = makeCtrl();
      expect(await ctrl.playTrack("spotify:track:abc")).toBe(true);
      expect(be.startCalls).toBe(1);
      expect(be.playCalls).toEqual(["spotify:track:abc"]);
    });
    it("returns false when the controller is unavailable", async () => {
      const { ctrl, be } = makeCtrl({ config: { enabled: false } });
      expect(await ctrl.playTrack("spotify:track:abc")).toBe(false);
      expect(be.playCalls).toEqual([]);
    });
    it("returns false when backend.playTrack rejects", async () => {
      const be = new FakeBackend();
      be.playShouldReject = true;
      const { ctrl } = makeCtrl({ backendFactory: () => be });
      expect(await ctrl.playTrack("spotify:track:abc")).toBe(false);
    });
  });

  describe("SpotifyController transport delegation", () => {
    it("pause/resume/seek forward to the backend after start", async () => {
      const { ctrl, be } = makeCtrl();
      await ctrl.ensureStarted();
      await ctrl.pause();
      await ctrl.resume();
      await ctrl.seek(4200);
      expect(be.pauseCalls).toBe(1);
      expect(be.resumeCalls).toBe(1);
      expect(be.seekCalls).toEqual([4200]);
    });
    it("pause/resume/seek are safe no-ops before start", async () => {
      const { ctrl, be } = makeCtrl();
      await expect(ctrl.pause()).resolves.toBeUndefined();
      await expect(ctrl.resume()).resolves.toBeUndefined();
      await expect(ctrl.seek(10)).resolves.toBeUndefined();
      expect(be.pauseCalls).toBe(0);
    });
    it("getPcmStream returns the backend stream", async () => {
      const { ctrl, be } = makeCtrl();
      await ctrl.ensureStarted();
      expect(ctrl.getPcmStream()).toBe(be.pcm);
    });
    it("getPcmStream throws before the backend is started", () => {
      const { ctrl } = makeCtrl();
      expect(() => ctrl.getPcmStream()).toThrow();
    });
  });

  describe("SpotifyController event re-emission", () => {
    it("re-emits backend trackEnded with the same payload", async () => {
      const { ctrl, be } = makeCtrl();
      await ctrl.ensureStarted();
      const got: SpotifyTrackEndedEvent[] = [];
      ctrl.on("trackEnded", (e) => got.push(e));
      const evt: SpotifyTrackEndedEvent = { uri: "spotify:track:x", reason: "ended" };
      be.emit("trackEnded", evt);
      expect(got).toEqual([evt]);
    });
    it("re-emits backend metadata with the same payload", async () => {
      const { ctrl, be } = makeCtrl();
      await ctrl.ensureStarted();
      const got: SpotifyNowPlaying[] = [];
      ctrl.on("metadata", (m) => got.push(m));
      const meta: SpotifyNowPlaying = {
        uri: "spotify:track:x",
        name: "Song",
        artist: "Artist",
        album: "Album",
        coverUrl: "http://img",
        durationMs: 1000,
      };
      be.emit("metadata", meta);
      expect(got).toEqual([meta]);
    });
  });

  describe("SpotifyController.stop", () => {
    it("stops the backend and tears down state so a later start rebuilds", async () => {
      const be1 = new FakeBackend();
      const be2 = new FakeBackend();
      const backends = [be1, be2];
      const { ctrl } = makeCtrl({ backendFactory: () => backends.shift()! });
      await ctrl.ensureStarted();
      ctrl.stop();
      expect(be1.stopCalls).toBe(1);
      // After teardown getPcmStream is invalid again until re-started.
      expect(() => ctrl.getPcmStream()).toThrow();
      // A fresh ensureStarted builds a new backend.
      expect(await ctrl.ensureStarted()).toBe(true);
      expect(be2.startCalls).toBe(1);
    });
    it("stop before start is a safe no-op", () => {
      const { ctrl, be } = makeCtrl();
      expect(() => ctrl.stop()).not.toThrow();
      expect(be.stopCalls).toBe(0);
    });
  });
  ```

  Verify (RED): `npx vitest run src/music/spotify/controller.test.ts` — expected to FAIL (cannot resolve `./controller.js`).

- [ ] **Step 2: Implement `src/music/spotify/controller.ts` to make the suite green.**
  Extends `EventEmitter`. `isAvailable()` is synchronous (`existsSync(findGoLibrespot())` — mirrors youtube.ts' bin/-first resolution). `ensureStarted()` caches an in-flight promise for idempotency and clears it on failure so a later call retries. The default `backendFactory` constructs `GoLibrespotBackend`; tests inject a fake so no binary/network is touched. Event re-emission is wired once, at backend construction time.

  ```ts
  import { EventEmitter } from "node:events";
  import { existsSync } from "node:fs";
  import type { Readable } from "node:stream";
  import type { Logger } from "pino";
  import type { SpotifyConfig } from "../../data/config.js";
  import type {
    SpotifyAudioBackend,
    SpotifyTrackEndedEvent,
    SpotifyNowPlaying,
  } from "./backend.js";
  import { isGoLibrespotSupported, findGoLibrespot } from "./binary.js";
  import { GoLibrespotBackend } from "./go-librespot.js";

  export interface SpotifyControllerOptions {
    config: SpotifyConfig;
    workDir: string;
    configDir: string;
    logger: Logger;
    /** Injected for tests; defaults to constructing a real GoLibrespotBackend. */
    backendFactory?: () => SpotifyAudioBackend;
  }

  /**
   * Per-bot orchestrator for the go-librespot Spotify sidecar. Owns backend
   * lifecycle, gates on availability (config + platform + binary), delegates
   * transport, and re-emits the backend's "trackEnded"/"metadata" events so
   * BotInstance can advance the queue exactly as it does for the ffmpeg path.
   */
  export class SpotifyController extends EventEmitter {
    private readonly config: SpotifyConfig;
    private readonly workDir: string;
    private readonly configDir: string;
    private readonly logger: Logger;
    private readonly backendFactory: () => SpotifyAudioBackend;

    private backend: SpotifyAudioBackend | null = null;
    private started = false;
    private startPromise: Promise<boolean> | null = null;

    constructor(o: SpotifyControllerOptions) {
      super();
      this.config = o.config;
      this.workDir = o.workDir;
      this.configDir = o.configDir;
      this.logger = o.logger;
      this.backendFactory =
        o.backendFactory ??
        (() =>
          new GoLibrespotBackend({
            deviceName: this.config.deviceName,
            bitrate: this.config.bitrate,
            workDir: this.workDir,
            configDir: this.configDir,
            logger: this.logger,
          }));
    }

    /** enabled in config AND on a supported OS AND the binary is present on disk. */
    isAvailable(): boolean {
      return (
        this.config.enabled &&
        isGoLibrespotSupported() &&
        existsSync(findGoLibrespot())
      );
    }

    /**
     * Idempotently start the backend. Returns false (without building a backend)
     * when unavailable, so callers fall back to the Stage-1 sentinel message.
     * A failed start clears the cached promise so a later call can retry.
     */
    async ensureStarted(): Promise<boolean> {
      if (!this.isAvailable()) return false;
      if (this.started) return true;
      if (this.startPromise) return this.startPromise;

      this.startPromise = (async () => {
        try {
          const backend = this.backendFactory();
          backend.on("trackEnded", (e: SpotifyTrackEndedEvent) =>
            this.emit("trackEnded", e),
          );
          backend.on("metadata", (m: SpotifyNowPlaying) =>
            this.emit("metadata", m),
          );
          backend.on("error", (err?: unknown) => this.emit("error", err));
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

    /** Tear down the backend and reset lifecycle state (safe before start). */
    stop(): void {
      if (this.backend) {
        this.backend.stop();
        this.backend = null;
      }
      this.started = false;
      this.startPromise = null;
    }
  }
  ```

  Verify (GREEN): `npx vitest run src/music/spotify/controller.test.ts` — all cases PASS.

- [ ] **Step 3: Typecheck the whole project.**
  Run `npx tsc --noEmit` — expected to PASS with no errors (confirms the `SpotifyAudioBackend`/`SpotifyConfig`/`GoLibrespotBackend` imports and the `FakeBackend implements SpotifyAudioBackend` structural match are correct). No existing files were modified in this task, so no existing tests can regress; if `tsc` flags a pre-existing unrelated error, do not fix it here.

- [ ] **Step 4: Commit.**
  ```sh
  git add src/music/spotify/controller.ts src/music/spotify/controller.test.ts
  git commit -m "$(cat <<'EOF'
  feat(spotify): SpotifyController backend lifecycle, gating, and event re-emission

  Per-bot orchestrator: isAvailable() gates on config.enabled + platform +
  binary presence; ensureStarted() starts the backend once (idempotent, retries
  on failure); playTrack/pause/resume/seek/stop delegate; getPcmStream() proxies
  the backend PCM; re-emits backend trackEnded/metadata. backendFactory injected
  for tests (fake backend, no real binary/network).

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 7: instance.ts orchestration + manager/index wiring

**Files:**
- MODIFY `src/bot/instance.ts` — construct one `SpotifyController` per `BotInstance`; replace the Stage‑1 sentinel-skip block in `resolveAndPlay` with the Spotify branch; wire controller `"trackEnded"` → `playNext`; delegate transport in `cmdPause`/`cmdResume`/`cmdStop` (+ teardown paths).
- MODIFY `src/bot/manager.ts` — add a `spotifyDataDir` ctor param and thread it into all three `new BotInstance({...})` sites.
- MODIFY `src/index.ts` — compute `SPOTIFY_DATA_DIR` under `DATA_DIR` and pass it to `new BotManager(...)`.
- ADD tests to `src/bot/instance.test.ts` — routing/branch/transport decisions on hand-built `ctx` via `Prototype.method.call(ctx)` (the existing test style). Live audio is not testable here.

**Interfaces:**

Consumes (verbatim from the LOCKED CONTRACT — do not redefine):
- `SpotifyController.constructor(o: { config: import("../../data/config.js").SpotifyConfig; workDir: string; configDir: string; logger: import("pino").Logger; backendFactory?: () => SpotifyAudioBackend })`
- `SpotifyController.ensureStarted(): Promise<boolean>` — idempotent; `false` ⇒ caller keeps the Stage‑1 fallback.
- `SpotifyController.playTrack(uri: string): Promise<boolean>`
- `SpotifyController.pause(): Promise<void>`; `resume(): Promise<void>`; `seek(ms: number): Promise<void>`; `stop(): void`
- `SpotifyController.getPcmStream(): import("node:stream").Readable`
- `SpotifyController.on("trackEnded", cb: (e: SpotifyTrackEndedEvent) => void)` / re-emitted `"metadata"` (extends `EventEmitter`)
- `interface SpotifyTrackEndedEvent { uri: string; reason: "ended" | "stopped" | "error" }` (from `backend.ts`)
- `AudioPlayer.playPcmStream(readable: Readable, opts: { onExternalEnd?: () => void }): void` (Player task)

Produces:
- `BotInstanceOptions` gains `spotifyDataDir?: string` and `spotifyControllerFactory?: (o: { config: SpotifyConfig; workDir: string; configDir: string; logger: Logger }) => SpotifyController`.
- `BotManager.constructor(...)` gains a trailing `spotifyDataDir?: string`.
- `BotInstance.resolveAndPlay(song: QueuedSong): Promise<boolean>` — now returns `true` for a started Spotify track (via `playPcmStream`), still returns `false` on the Stage‑1 fallback.

---

- [ ] **Step 1: Scaffold the per-bot SpotifyController (imports, options, field, ctor wiring). Existing behavior preserved.**

  In `src/bot/instance.ts`, extend the imports. Change line 18 and add two new imports after line 26:

  ```ts
  // line 18 — add SpotifyConfig to the existing type import
  import type { BotConfig, SpotifyConfig } from "../data/config.js";
  ```

  ```ts
  // after line 26 (import { isSpotifyUri } ...)
  import path from "node:path";
  import { SpotifyController } from "../music/spotify/controller.js";
  import type { SpotifyTrackEndedEvent } from "../music/spotify/backend.js";
  ```

  Add the new option fields to `BotInstanceOptions` (after `avatarStore: AvatarStore;`, before the closing brace ~line 45):

  ```ts
    avatarStore: AvatarStore;
    /** Base dir (under DATA_DIR) for per-bot go-librespot work/config trees. */
    spotifyDataDir?: string;
    /** Test seam: build a fake controller instead of a real go-librespot one. */
    spotifyControllerFactory?: (o: {
      config: SpotifyConfig;
      workDir: string;
      configDir: string;
      logger: Logger;
    }) => SpotifyController;
  ```

  Declare the two new private fields (after `private player: AudioPlayer;` ~line 68, and near `private autoPaused = false;`):

  ```ts
    private player: AudioPlayer;
    private spotifyController: SpotifyController;
  ```

  ```ts
    private autoPaused = false;
    /** True while the audible track is served by the Spotify sidecar (external
     *  PCM mode) — drives fence/handoff decisions in resolveAndPlay + cmdStop. */
    private currentSourceIsSpotify = false;
  ```

  Construct the controller in the ctor, immediately after `this.queue = new PlayQueue();` (line 115) — it must exist before `setupPlayerEvents()` runs:

  ```ts
      this.queue = new PlayQueue();

      // One long-lived Spotify sidecar controller per bot. Construction is
      // cheap and side-effect-free — nothing spawns until ensureStarted().
      const spotifyBase =
        options.spotifyDataDir ?? path.join(process.cwd(), "data", "spotify");
      const spotifyWorkDir = path.join(spotifyBase, this.id, "work");
      const spotifyConfigDir = path.join(spotifyBase, this.id, "config");
      const buildController =
        options.spotifyControllerFactory ??
        ((o) => new SpotifyController({ ...o }));
      this.spotifyController = buildController({
        config: this.config.spotify,
        workDir: spotifyWorkDir,
        configDir: spotifyConfigDir,
        logger: this.logger,
      });
  ```

  Verify (scaffolding compiles; existing tests untouched):
  - `npx tsc --noEmit` → PASS
  - `npx vitest run src/bot/instance.test.ts` → PASS (existing suites still green)

- [ ] **Step 2 (RED): Add the Spotify orchestration tests to `src/bot/instance.test.ts`.**

  Append these suites at the end of the file. They drive the REAL prototype methods on a hand-built `ctx` (the file's established `.call(ctx)` style) and assert real routing behavior — a Spotify song must hit `controller.playTrack` + `player.playPcmStream`, never `player.play`.

  ```ts
  // --- Spotify orchestration (Task 7) --------------------------------------

  const resolveAndPlay = BotInstance.prototype.resolveAndPlay as (
    this: unknown,
    song: any,
  ) => Promise<boolean>;
  const setupPlayerEvents = (BotInstance.prototype as any).setupPlayerEvents as (
    this: unknown,
  ) => void;
  const cmdPause = (BotInstance.prototype as any).cmdPause as (this: unknown) => string;
  const cmdResume = (BotInstance.prototype as any).cmdResume as (this: unknown) => string;
  const cmdStop = (BotInstance.prototype as any).cmdStop as (this: unknown) => string;

  function makeController() {
    return {
      ensureStarted: vi.fn(async () => true),
      playTrack: vi.fn(async () => true),
      getPcmStream: vi.fn(() => ({ kind: "pcm" } as any)),
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      stop: vi.fn(() => {}),
      on: vi.fn(),
    };
  }
  function makePlayer() {
    return {
      play: vi.fn(),
      stop: vi.fn(),
      playPcmStream: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    };
  }
  function makeResolveCtx(opts: {
    controller: ReturnType<typeof makeController>;
    player: ReturnType<typeof makePlayer>;
    url: string;
    song: any;
    currentSourceIsSpotify?: boolean;
  }) {
    return {
      connected: true,
      config: {},
      id: "bot1",
      voteSkipUsers: new Set<string>(),
      autoPaused: false,
      currentSourceIsSpotify: opts.currentSourceIsSpotify ?? false,
      effectiveDuration: undefined,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      tsClient: { sendTextMessage: vi.fn(async () => {}) },
      database: { addPlayHistory: vi.fn() },
      spotifyController: opts.controller,
      player: opts.player,
      getProviderFor: vi.fn(() => ({ getSongUrl: async () => ({ url: opts.url }) })),
      syncProfileToSong: vi.fn(async () => {}),
      emit: vi.fn(),
    } as any;
  }
  function spotifySong() {
    return {
      id: "abc",
      name: "Song",
      artist: "Artist",
      album: "Album",
      platform: "spotify",
      coverUrl: "c",
      duration: 200,
      url: "",
    };
  }

  describe("BotInstance.resolveAndPlay — Spotify routing", () => {
    it("routes a spotify song to controller.playTrack + player.playPcmStream, not player.play", async () => {
      const controller = makeController();
      const player = makePlayer();
      const song = spotifySong();
      const ctx = makeResolveCtx({ controller, player, url: "spotify:track:abc", song });

      const ok = await resolveAndPlay.call(ctx, song);

      expect(ok).toBe(true);
      expect(controller.ensureStarted).toHaveBeenCalledTimes(1);
      expect(controller.playTrack).toHaveBeenCalledWith("spotify:track:abc");
      expect(player.playPcmStream).toHaveBeenCalledTimes(1);
      expect(player.playPcmStream.mock.calls[0][0]).toEqual({ kind: "pcm" });
      expect(player.play).not.toHaveBeenCalled();
      expect(ctx.currentSourceIsSpotify).toBe(true);
      expect(ctx.database.addPlayHistory).toHaveBeenCalledTimes(1);
      expect(ctx.emit).toHaveBeenCalledWith("stateChange");
    });

    it("returns false + sends the Stage-1 fallback when the backend is unavailable", async () => {
      const controller = makeController();
      controller.ensureStarted = vi.fn(async () => false);
      const player = makePlayer();
      const song = spotifySong();
      const ctx = makeResolveCtx({ controller, player, url: "spotify:track:abc", song });

      const ok = await resolveAndPlay.call(ctx, song);

      expect(ok).toBe(false);
      expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledTimes(1);
      expect(controller.playTrack).not.toHaveBeenCalled();
      expect(player.playPcmStream).not.toHaveBeenCalled();
      expect(player.play).not.toHaveBeenCalled();
    });

    it("fences the URL player (player.stop) when switching from non-spotify to spotify", async () => {
      const controller = makeController();
      const player = makePlayer();
      const song = spotifySong();
      const ctx = makeResolveCtx({
        controller, player, url: "spotify:track:abc", song, currentSourceIsSpotify: false,
      });

      await resolveAndPlay.call(ctx, song);

      expect(player.stop).toHaveBeenCalledTimes(1);
      expect(player.playPcmStream).toHaveBeenCalledTimes(1);
    });

    it("keeps the stream attached (no player.stop) on a spotify→spotify handoff", async () => {
      const controller = makeController();
      const player = makePlayer();
      const song = spotifySong();
      const ctx = makeResolveCtx({
        controller, player, url: "spotify:track:abc", song, currentSourceIsSpotify: true,
      });

      await resolveAndPlay.call(ctx, song);

      expect(player.stop).not.toHaveBeenCalled();
      expect(controller.playTrack).toHaveBeenCalledWith("spotify:track:abc");
      expect(player.playPcmStream).toHaveBeenCalledTimes(1);
    });

    it("pauses the sidecar and clears the flag when switching to a non-spotify track", async () => {
      const controller = makeController();
      const player = makePlayer();
      const song = { ...spotifySong(), platform: "netease" };
      const ctx = makeResolveCtx({
        controller, player, url: "http://cdn/x.mp3", song, currentSourceIsSpotify: true,
      });

      const ok = await resolveAndPlay.call(ctx, song);

      expect(ok).toBe(true);
      expect(controller.pause).toHaveBeenCalledTimes(1);
      expect(ctx.currentSourceIsSpotify).toBe(false);
      expect(player.play).toHaveBeenCalledWith("http://cdn/x.mp3", 0, 200);
      expect(player.playPcmStream).not.toHaveBeenCalled();
    });
  });

  describe("BotInstance.setupPlayerEvents — controller trackEnded wiring", () => {
    function makeEventCtx(currentPlatform: string) {
      return {
        spotifyController: { on: vi.fn() },
        player: { on: vi.fn() },
        queue: { current: vi.fn(() => ({ platform: currentPlatform })) },
        logger: { debug: vi.fn(), error: vi.fn() },
        playNext: vi.fn(async () => true),
      } as any;
    }
    function trackEndedHandler(ctx: any) {
      const call = ctx.spotifyController.on.mock.calls.find(
        (c: any[]) => c[0] === "trackEnded",
      );
      expect(call).toBeDefined();
      return call[1] as (e: any) => void;
    }

    it("advances via playNext when the current song is spotify", () => {
      const ctx = makeEventCtx("spotify");
      setupPlayerEvents.call(ctx);
      trackEndedHandler(ctx)({ uri: "spotify:track:x", reason: "ended" });
      expect(ctx.playNext).toHaveBeenCalledTimes(1);
    });

    it("ignores controller trackEnded when the current song is not spotify", () => {
      const ctx = makeEventCtx("netease");
      setupPlayerEvents.call(ctx);
      trackEndedHandler(ctx)({ uri: "spotify:track:x", reason: "ended" });
      expect(ctx.playNext).not.toHaveBeenCalled();
    });
  });

  describe("BotInstance transport delegation — spotify current song", () => {
    function makeCmdCtx(currentPlatform: string) {
      return {
        player: { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() },
        spotifyController: {
          pause: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
          stop: vi.fn(() => {}),
        },
        queue: { current: vi.fn(() => ({ platform: currentPlatform })), clear: vi.fn() },
        logger: { warn: vi.fn() },
        emit: vi.fn(),
        autoPaused: true,
        currentSourceIsSpotify: true,
        sweepLocalAudio: vi.fn(),
        disableFmMode: vi.fn(),
        profileManager: { onSongChange: vi.fn(async () => {}) },
      } as any;
    }

    it("cmdPause delegates to controller.pause when current is spotify", () => {
      const ctx = makeCmdCtx("spotify");
      cmdPause.call(ctx);
      expect(ctx.player.pause).toHaveBeenCalled();
      expect(ctx.spotifyController.pause).toHaveBeenCalledTimes(1);
    });

    it("cmdResume delegates to controller.resume when current is spotify", () => {
      const ctx = makeCmdCtx("spotify");
      cmdResume.call(ctx);
      expect(ctx.player.resume).toHaveBeenCalled();
      expect(ctx.spotifyController.resume).toHaveBeenCalledTimes(1);
    });

    it("cmdStop stops the sidecar + player and clears the spotify flag", () => {
      const ctx = makeCmdCtx("spotify");
      cmdStop.call(ctx);
      expect(ctx.spotifyController.stop).toHaveBeenCalledTimes(1);
      expect(ctx.player.stop).toHaveBeenCalledTimes(1);
      expect(ctx.queue.clear).toHaveBeenCalledTimes(1);
      expect(ctx.currentSourceIsSpotify).toBe(false);
    });

    it("does NOT touch the controller when current is not spotify", () => {
      const ctx = makeCmdCtx("netease");
      cmdPause.call(ctx);
      cmdResume.call(ctx);
      expect(ctx.spotifyController.pause).not.toHaveBeenCalled();
      expect(ctx.spotifyController.resume).not.toHaveBeenCalled();
    });
  });
  ```

  Verify (implementation absent ⇒ RED):
  - `npx vitest run src/bot/instance.test.ts` → FAIL (the `resolveAndPlay — Spotify routing`, `setupPlayerEvents`, and `transport delegation` suites fail: current code sends the sentinel message and returns `false`, never calls `playTrack`/`playPcmStream`, and `setupPlayerEvents` never registers a `"trackEnded"` handler)

- [ ] **Step 3 (GREEN): Replace the Stage‑1 sentinel-skip block in `resolveAndPlay` with the Spotify branch + non-spotify transition pause.**

  In `src/bot/instance.ts`, replace the sentinel block at lines 594–600 (the `if (isSpotifyUri(result.url)) { ... return false; }` that only warns and skips). Everything before it (connection guard, `getSongUrl`, post-await reconnect check) and the non-spotify tail (`song.url = result.url; this.effectiveDuration = ...; this.player.play(...)` etc.) is preserved. Replace only the block:

  ```ts
        // Stage 2: a `spotify:` sentinel URI means the go-librespot sidecar
        // serves the audio, NOT ffmpeg. Start the per-bot sidecar on demand;
        // if it can't run (disabled / non-Linux / binary missing) keep the
        // Stage-1 fallback message + skip so the queue keeps moving.
        if (isSpotifyUri(result.url)) {
          const ready = await this.spotifyController.ensureStarted();
          if (!ready) {
            this.logger.info({ songId: song.id, name: song.name }, "Spotify backend unavailable — skipping");
            await this.tsClient.sendTextMessage(
              "⚠️ Spotify 播放尚未启用（需要 librespot 音频后端，将在后续版本支持）。"
            );
            return false;
          }
          // Coming from a URL track: fence the per-URL ffmpeg player so its
          // pcmBuffer can't collide with the external PCM stream. On a
          // spotify→spotify handoff keep the sidecar stream attached (gapless).
          if (!this.currentSourceIsSpotify) {
            this.player.stop();
          }
          await this.spotifyController.playTrack(result.url);
          this.player.playPcmStream(this.spotifyController.getPcmStream(), {
            onExternalEnd: () => {
              // The sidecar PCM pipe is long-lived; per-track end arrives via
              // the controller "trackEnded" WS event, not stream EOF. A real
              // EOF here means the sidecar died — log; recovery is the
              // controller's job.
              this.logger.warn("Spotify PCM stream ended unexpectedly");
            },
          });
          this.currentSourceIsSpotify = true;
          song.url = result.url;
          // No trial clip for Spotify — full-track duration only (near-end
          // stall logic is disabled for the external stream anyway).
          this.effectiveDuration = song.duration;
          this.autoPaused = false;
          this.database.addPlayHistory({
            botId: this.id,
            songId: song.id,
            songName: song.name,
            artist: song.artist,
            album: song.album,
            platform: song.platform,
            coverUrl: song.coverUrl,
          });
          await this.syncProfileToSong(song);
          this.emit("stateChange");
          return true;
        }
        // Non-Spotify track: if we were on Spotify, pause the sidecar so it
        // stops decoding ahead before the URL ffmpeg reclaims the PCM buffer.
        if (this.currentSourceIsSpotify) {
          this.spotifyController.pause().catch((err) =>
            this.logger.warn({ err }, "Failed to pause Spotify sidecar on source switch"));
          this.currentSourceIsSpotify = false;
        }
  ```

  Do not touch the lines below it (`song.url = result.url;` onward) — the non-spotify path continues to call `this.player.play(...)` exactly as before.

- [ ] **Step 4 (GREEN): Wire the controller `"trackEnded"` → `playNext` in `setupPlayerEvents`. Existing player `"frame"`/`"trackEnd"`/`"error"` handlers preserved.**

  In `src/bot/instance.ts`, append to the end of `setupPlayerEvents()` (after the existing `this.player.on("error", ...)` block, before the method's closing brace ~line 158):

  ```ts
      // Spotify advances exclusively via the sidecar's WebSocket "trackEnded"
      // (the continuous go-librespot→ffmpeg pipe never EOFs per track, so the
      // player's own underrun "trackEnd" is suppressed in external mode). Guard
      // on the current song being spotify so a stray event can't double-advance
      // a URL track; playNext()'s isAdvancing guard covers any residual race.
      this.spotifyController.on("trackEnded", (_e: SpotifyTrackEndedEvent) => {
        if (this.queue.current()?.platform !== "spotify") return;
        this.logger.debug("Spotify track ended, advancing queue");
        this.playNext().catch((err) => {
          this.logger.error({ err }, "playNext failed after spotify trackEnded");
        });
      });
  ```

- [ ] **Step 5 (GREEN): Delegate transport in `cmdPause`/`cmdResume`/`cmdStop` and add sidecar teardown to the stop/clear/disconnect paths. Existing behavior preserved for non-spotify.**

  In `src/bot/instance.ts`, update `cmdPause` (768) and `cmdResume` (776) to also drive the sidecar when the current song is Spotify (still synchronous — the REST calls are fire-and-forget):

  ```ts
    private cmdPause(): string {
      this.player.pause();
      if (this.queue.current()?.platform === "spotify") {
        this.spotifyController.pause().catch((err) =>
          this.logger.warn({ err }, "Spotify pause failed"));
      }
      // User-initiated pause — clear auto-pause so occupancy won't auto-resume it.
      this.autoPaused = false;
      this.emit("stateChange");
      return "Paused";
    }

    private cmdResume(): string {
      this.player.resume();
      if (this.queue.current()?.platform === "spotify") {
        this.spotifyController.resume().catch((err) =>
          this.logger.warn({ err }, "Spotify resume failed"));
      }
      // User-initiated resume — drop any auto-pause flag.
      this.autoPaused = false;
      this.emit("stateChange");
      return "Resumed";
    }
  ```

  Update `cmdStop` (784) — read `queue.current()` BEFORE `queue.clear()`, stop the sidecar, and clear the flag:

  ```ts
    private cmdStop(): string {
      if (this.queue.current()?.platform === "spotify") {
        this.spotifyController.stop();
      }
      this.currentSourceIsSpotify = false;
      this.player.stop();
      this.autoPaused = false;
      this.queue.clear();
      this.sweepLocalAudio("stopped");
      this.disableFmMode();
      this.profileManager.onSongChange(null).catch((err) => {
        this.logger.warn({ err }, "Profile restore failed on stop");
      });
      this.emit("stateChange");
      return "Stopped and queue cleared";
    }
  ```

  Add the same detach to the other `player.stop()` teardown paths so the sidecar can't stream into a dead player (`stop()` is a safe no-op when the backend was never started). In `cmdClear` (844), the `disconnected` handler (208), and `disconnect()` (291), insert `this.spotifyController.stop();` and `this.currentSourceIsSpotify = false;` immediately before the existing `this.player.stop();`. For example in `disconnect()`:

  ```ts
    disconnect(): void {
      this._cancelIdleTimer();
      this.spotifyController.stop();
      this.currentSourceIsSpotify = false;
      this.player.stop();
      this.queue.clear();
      // ...unchanged...
  ```

  Verify (implementation complete ⇒ GREEN):
  - `npx vitest run src/bot/instance.test.ts` → PASS (all Spotify suites green; the pre-existing `runExclusive`, permission-gate, and `getProviderFor` suites remain green)
  - `npx tsc --noEmit` → PASS

- [ ] **Step 6: Thread `spotifyDataDir` through `BotManager` into all three `BotInstance` sites.**

  In `src/bot/manager.ts`, add the `node:path` import at the top (after the existing `node:crypto`/`node:events` imports):

  ```ts
  import path from "node:path";
  ```

  Add a field and a trailing ctor param. Add to the field list (after `private spotifyProvider: MusicProvider;` ~line 79):

  ```ts
    private spotifyDataDir: string;
  ```

  Extend the constructor signature — append after `spotifyProvider?: MusicProvider` (line 99) and initialize in the body (after `this.spotifyProvider = ...` line 108):

  ```ts
      spotifyProvider?: MusicProvider,
      spotifyDataDir?: string
    ) {
  ```

  ```ts
      this.spotifyProvider = spotifyProvider ?? neteaseProvider;
      this.spotifyDataDir = spotifyDataDir ?? path.join(process.cwd(), "data", "spotify");
  ```

  Then add `spotifyDataDir: this.spotifyDataDir,` to each of the THREE `new BotInstance({ ... })` option objects — in `createBot` (after `avatarStore: this.avatarStore,` ~line 151), in `startBot` (~line 292), and in `loadSavedBots` (~line 347):

  ```ts
        avatarStore: this.avatarStore,
        spotifyDataDir: this.spotifyDataDir,
      });
  ```

  Verify:
  - `npx tsc --noEmit` → PASS

- [ ] **Step 7: Wire `src/index.ts` — pass the per-install Spotify data dir into `BotManager`.**

  In `src/index.ts`, add the dir constant alongside the other `DATA_DIR`-derived paths (after `const LOCAL_AUDIO_DIR = ...` ~line 31):

  ```ts
  const SPOTIFY_DATA_DIR = path.join(DATA_DIR, "spotify");
  ```

  Pass it as the new trailing argument to the `BotManager` construction (after `spotifyProvider` at line 97):

  ```ts
    const botManager = new BotManager(
      neteaseProvider,
      qqProvider,
      bilibiliProvider,
      db,
      config,
      logger,
      avatarStore,
      permissions,
      CONFIG_PATH,
      localProvider,
      kugouProvider,
      spotifyProvider,
      SPOTIFY_DATA_DIR
    );
  ```

  Verify (full project type-check + full test run):
  - `npx tsc --noEmit` → PASS
  - `npx vitest run src/bot/instance.test.ts` → PASS

- [ ] **Step 8: Commit.**

  ```bash
  git add src/bot/instance.ts src/bot/manager.ts src/index.ts src/bot/instance.test.ts
  git commit -m "$(cat <<'EOF'
  feat(spotify): orchestrate go-librespot backend from BotInstance (Stage 2 Task 7)

  Construct one SpotifyController per bot (config.spotify + per-bot work/config
  dirs under DATA_DIR, threaded via BotManager + index). resolveAndPlay now
  routes spotify: sentinels through controller.ensureStarted/playTrack +
  player.playPcmStream (falling back to the Stage-1 message when unavailable),
  fences/pauses the sidecar on source transitions, advances via controller
  "trackEnded", and delegates pause/resume/stop transport.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 8: Whole-stage verification

**Files:** none (verification only).

- [ ] **Step 1: Full backend suite**

Run: `npx vitest run`
Expected: all tests pass (existing + new Stage-2 unit tests; no regressions).

- [ ] **Step 2: Typecheck + frontend build**

Run: `npx tsc --noEmit && cd web && npm run build`
Expected: zero type errors; frontend builds (unchanged in Stage 2, but confirm no breakage).

- [ ] **Step 3: Gating sanity (documented)**

Confirm by reading (not running a live sidecar): on a non-Linux host `isGoLibrespotSupported()` is false, so `SpotifyController.ensureStarted()` returns false and `resolveAndPlay` uses the Stage-1 sentinel message — i.e. Stage 1's behavior is preserved everywhere the backend can't run. State in the commit/report that live audio playback was NOT verified here (requires Premium + Linux + a real go-librespot sidecar) and list exactly what WAS verified (unit tests with mocked process/HTTP/WS/FS, tsc, build).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore(spotify): stage 2 verification pass" --allow-empty
```
