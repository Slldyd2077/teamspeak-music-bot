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
 *
 * Correction C3: this controller does NOT re-emit a raw "error" event (Node's
 * EventEmitter throws on an unhandled "error"). It subscribes to the backend's
 * "error", logs it, and marks itself not-ready so the next ensureStarted()
 * relaunches the backend. Only the safe "trackEnded"/"metadata" events are
 * re-emitted. getPcmStream() proxies the backend's SINGLE persistent stream
 * (no per-attach PassThrough) to pair with the AudioPlayer detach-not-destroy
 * behaviour and BotInstance's no-re-attach on spotify->spotify transitions.
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
   * an EventEmitter throws). Logs and marks the controller not-ready so the
   * next ensureStarted() relaunches the backend.
   */
  private handleBackendError(err: unknown): void {
    this.logger.error({ err }, "Spotify backend error; marking not-ready");
    // Tear down the errored backend BEFORE resetting flags so ensureStarted()
    // does not orphan it: stop() cleans its ffmpeg/go-librespot children + FIFO,
    // removeAllListeners() detaches its "error" handler so a later error from
    // this now-orphaned backend cannot flip a healthy rebuilt controller
    // back to not-ready (state cross-talk). Teardown must never mask the
    // original error, so guard stop() which may throw.
    try {
      this.backend?.stop();
    } catch (stopErr) {
      this.logger.error(
        { err: stopErr },
        "Spotify backend stop() threw during error teardown",
      );
    }
    // SpotifyAudioBackend's type contract exposes on() but not
    // removeAllListeners(); every concrete backend extends EventEmitter, so
    // detach through it to drop this controller's listeners from the orphan.
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
