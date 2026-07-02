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

    if (!state) {
      // C3.5: a 204 / no-active-device response. AFTER our own track has been
      // seen playing, librespot going idle means the track ended — emit once so
      // the queue advances instead of stalling. BEFORE any play (hasPlayed
      // false), a null state is just "nothing active yet" and is ignored.
      if (this.hasPlayed && this.currentUri && !this.endedForCurrent) {
        this.endedForCurrent = true;
        const endedUri = this.currentUri;
        this.currentUri = null;
        const e: SpotifyTrackEndedEvent = { uri: endedUri, reason: "ended" };
        this.emit("trackEnded", e);
      }
      return;
    }

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

    // C3.4: EVERY end condition is gated on hasPlayed so no end can fire until
    // the bot's own track has actually been observed playing. Without this, the
    // first poll (before playTrack) could observe the account's stale/paused
    // track sitting near its end and spuriously emit "trackEnded".
    const finishedByProgress =
      this.hasPlayed &&
      state.durationMs > 0 &&
      state.progressMs >= state.durationMs - END_OF_TRACK_WINDOW_MS;
    const finishedByStop = this.hasPlayed && !state.isPlaying;
    const finishedByNull = this.hasPlayed && state.trackUri === null;

    if (finishedByProgress || finishedByStop || finishedByNull) {
      this.endedForCurrent = true; // latch: emit at most once per track
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
    // Reset the track-end state machine for the new track: clear the once-only
    // latch and drop hasPlayed so no end can fire until a poll re-confirms this
    // uri playing. currentUri is cleared so the next poll re-detects the track
    // (fresh metadata) rather than treating it as unchanged.
    this.currentUri = null;
    this.hasPlayed = false;
    this.endedForCurrent = false;
    // transfer(false) activates our device WITHOUT starting audio; play() then
    // actually starts the uri. The two-step is required — transfer alone won't
    // begin playback.
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
    // Clear the state poll interval FIRST so no poll fires mid-teardown.
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
