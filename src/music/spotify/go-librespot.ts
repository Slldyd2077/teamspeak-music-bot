import { EventEmitter } from "node:events";
// The go-librespot sidecar is Linux/Docker-gated (mkfifo + Linux-only binary),
// so the FIFO and config-dir paths are ALWAYS POSIX. Use posix.join so the
// separators are correct on the Linux target regardless of the host OS.
import { posix as posixPath } from "node:path";
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
import { getFfmpegCommand } from "../../audio/player.js";

export interface GoLibrespotBackendOptions {
  deviceName: string;
  bitrate: number;
  workDir: string;
  configDir: string;
  apiPort?: number;
  callbackPort?: number;
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
  /**
   * C1: override the ffmpeg command. Production resolves it via
   * getFfmpegCommand() (bundled ffmpeg-static fallback when `ffmpeg` isn't on
   * PATH, the Docker case); tests pin it to "ffmpeg" for stable arg assertions.
   */
  ffmpegCommand?: string;
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
  private readonly callbackPort: number;
  private readonly fifoPath: string;

  private ffmpeg: ChildProcess | null = null;
  private proc: ChildProcess | null = null;
  private rest: GoLibrespotRestClient | null = null;
  private events: GoLibrespotEventClient | null = null;
  private ready = false;
  private positionMs = 0;
  // R4-2: distinguishes an INTENTIONAL teardown (stop()/failed start()) — where a
  // sidecar exit is expected and must be silent — from an UNEXPECTED death that
  // must degrade-to-skip + surface an error so the controller relaunches.
  private stopping = false;
  // The uri of the track currently loaded in the sidecar (set by playTrack and
  // refreshed from metadata). Used as the trackEnded uri on an unexpected death
  // (R4-2) and on reconnect reconciliation (R4-3).
  private currentUri = "";
  // At-most-one trackEnded per track. Set when we emit a track-end, cleared when
  // a new track begins. Keeps the reconnect re-sync (R4-3) from double-emitting
  // with a live not_playing/stopped event.
  private endLatched = false;

  constructor(o: GoLibrespotBackendOptions) {
    super();
    this.opts = o;
    this.log = o.logger;
    this.deps = o.deps ?? {};
    this.apiPort = o.apiPort ?? DEFAULT_API_PORT;
    this.callbackPort = o.callbackPort ?? DEFAULT_CALLBACK_PORT;
    this.fifoPath = posixPath.join(o.workDir, FIFO_NAME);
  }

  async start(): Promise<void> {
    // Fresh lifecycle (also covers a start() after a previous stop() on the same
    // instance): clear the teardown flag and per-track end state.
    this.stopping = false;
    this.currentUri = "";
    this.endLatched = false;
    const spawn = this.deps.spawn ?? realSpawn;
    const execFileSync = this.deps.execFileSync ?? realExecFileSync;
    const existsSync = this.deps.existsSync ?? realExistsSync;
    const mkdirSync = this.deps.mkdirSync ?? realMkdirSync;
    const unlinkSync = this.deps.unlinkSync ?? realUnlinkSync;
    const writeFileSync = this.deps.writeFileSync ?? realWriteFileSync;
    const findBinary = this.deps.findBinary ?? findGoLibrespot;
    // C1: resolve ffmpeg via the repo's getFfmpegCommand() (ffmpeg-static
    // fallback) unless a command is injected for tests.
    const ffmpegCommand = this.deps.ffmpegCommand ?? getFfmpegCommand();

    // 1. Ensure work + config directories exist.
    mkdirSync(this.opts.workDir, { recursive: true });
    mkdirSync(this.opts.configDir, { recursive: true });

    // 2. (Re)create the FIFO — mkfifo fails if the path already exists.
    if (existsSync(this.fifoPath)) unlinkSync(this.fifoPath);
    execFileSync("mkfifo", [this.fifoPath]);

    // Everything past this point spawns processes / opens sockets. If any step
    // throws (e.g. the readiness poll times out), tear down whatever was already
    // created via stop() (kill ffmpeg + go-librespot, close WS, remove FIFO) so
    // we don't leak child processes or leave the FIFO on disk, then rethrow.
    try {
      // 3. Spawn ffmpeg FIRST so the PCM reader is attached to the FIFO before
      //    go-librespot (the writer) starts pushing raw 44.1k s16le into it.
      //    Opening the FIFO for writing before a reader exists errors with ENXIO.
      this.ffmpeg = spawn(
        ffmpegCommand,
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
      this.ffmpeg.on("error", (err) => this.emitError(err));

      // 4. Render + write config.yml into the config dir.
      const yml = renderConfigYml({
        deviceName: this.opts.deviceName,
        bitrate: this.opts.bitrate,
        fifoPath: this.fifoPath,
        // The go-librespot control API is UNAUTHENTICATED and the client only
        // ever connects via 127.0.0.1; the sidecar runs in the SAME container
        // as the bot, so bind to loopback rather than exposing it on 0.0.0.0.
        apiAddress: "127.0.0.1",
        apiPort: this.apiPort,
        callbackPort: this.callbackPort,
      });
      writeFileSync(posixPath.join(this.opts.configDir, "config.yml"), yml, "utf8");

      // 5. Spawn go-librespot AFTER ffmpeg is listening on the FIFO. Its stdout/
      //    stderr carry the interactive OAuth URL on first run — surface via logger.
      const bin = findBinary();
      this.proc = spawn(bin, ["--config_dir", this.opts.configDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const onLog = (b: Buffer) => this.log.info({ golibrespot: b.toString().trim() }, "go-librespot");
      this.proc.stdout?.on("data", onLog);
      this.proc.stderr?.on("data", onLog);
      this.proc.on("error", (err) => this.emitError(err));
      this.proc.on("exit", (code, signal) => {
        this.ready = false;
        this.log.warn({ code, signal }, "go-librespot exited");
        // R4-2: a stop()-initiated exit is expected — stay silent. Any other exit
        // is the sidecar dying under us and must be recovered.
        if (this.stopping) return;
        this.onUnexpectedExit(code, signal);
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
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  /**
   * Re-emit a child-process "error" only when a consumer is listening; Node
   * throws on an unhandled "error" event (can crash the process), so with no
   * listener we log via the injected logger instead. Mirrors the WS client's
   * listenerCount("error") gate in go-librespot-api.ts.
   */
  private emitError(err: unknown): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    } else {
      this.log.error({ err }, "go-librespot backend error (no listener)");
    }
  }

  /**
   * At-most-one track-end per track. The WS not_playing/stopped events, the
   * unexpected-death degrade (R4-2) and the reconnect re-sync (R4-3) all funnel
   * through here so a track can only advance the queue once.
   */
  private emitTrackEnded(e: SpotifyTrackEndedEvent): void {
    if (this.endLatched) return;
    this.endLatched = true;
    this.emit("trackEnded", e);
  }

  /**
   * R4-2: the go-librespot sidecar died without a stop() from us. Spotify
   * auto-advance is driven ONLY by the WS trackEnded event (the player-side stall
   * watchdog is disabled in external mode), so a silent death would stall the
   * queue forever. Mirror the Rust I4 degrade-to-skip:
   *  (a) emit trackEnded{reason:"error"} so BotInstance advances the queue;
   *  (b) stop the WS reconnect loop so it stops hammering the now-dead API port;
   *  (c) surface via emitError so the controller tears down + relaunches a fresh
   *      backend on the next ensureStarted().
   * trackEnded MUST be emitted BEFORE emitError: the controller's error handler
   * removeAllListeners() on teardown, so a trackEnded emitted after would be lost.
   */
  private onUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
    // (b) Kill the reconnect loop first — the API port is dead.
    try {
      this.events?.stop();
    } catch {
      /* ignore */
    }
    this.events = null;
    // (a) Degrade-to-skip only if a track was actually loaded; a death during
    // startup with nothing playing has no queue item to advance.
    if (this.currentUri) {
      this.emitTrackEnded({ uri: this.currentUri, reason: "error" });
    }
    // (c) Surface so the controller rebuilds.
    this.emitError(
      new Error(
        `go-librespot exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      ),
    );
  }

  /**
   * R4-3: the WS reconnected after a drop. go-librespot only pushes events (it is
   * never polled after startup), so a not_playing/stopped emitted during the
   * down window is lost and the queue would stall. Re-query GET /status and, if
   * playback is no longer active (the track ended in the gap), emit trackEnded so
   * the queue advances. Idempotent via the end-latch (no double-emit with a live
   * event). Only fired on a real reconnect — never the initial connect.
   */
  private async reconcileAfterReconnect(): Promise<void> {
    const rest = this.rest;
    if (!rest) return;
    const status = await rest.getStatus();
    // Couldn't read status — don't guess a track-end.
    if (!status) return;
    const active = status.track != null && !status.stopped;
    if (!active) {
      this.emitTrackEnded({ uri: this.currentUri, reason: "ended" });
    }
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
      // A new track is now playing: remember it (for R4-2/R4-3) and clear the
      // per-track end-latch so its eventual end can advance the queue.
      if (np.uri && np.uri !== this.currentUri) {
        this.currentUri = np.uri;
        this.endLatched = false;
      }
      this.emit("metadata", np);
    });
    ev.on("seek", (d: any) => {
      if (typeof d?.position === "number") this.positionMs = d.position;
    });
    ev.on("not_playing", (d: any) => {
      this.emitTrackEnded({ uri: typeof d?.uri === "string" ? d.uri : "", reason: "ended" });
    });
    ev.on("stopped", (d: any) => {
      this.emitTrackEnded({ uri: typeof d?.uri === "string" ? d.uri : "", reason: "stopped" });
    });
    // R4-3: reconcile any track-end missed while the WS was down.
    ev.on("reconnected", () => {
      void this.reconcileAfterReconnect();
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  async playTrack(uri: string): Promise<void> {
    if (!this.rest) throw new Error("go-librespot backend not started");
    // Track what is loaded so an unexpected death (R4-2) / reconnect re-sync
    // (R4-3) can advance the queue for the right uri, and reset the end-latch.
    this.currentUri = uri;
    this.endLatched = false;
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
    // R4-2: mark this an INTENTIONAL teardown so the go-librespot 'exit' handler
    // (fired by the SIGTERM below) stays silent instead of degrading-to-skip.
    this.stopping = true;
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
