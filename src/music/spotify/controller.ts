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
import {
  resolveSpotifyBackendKind,
  type SpotifyBackendKind,
} from "./backend-select.js";
export type { SpotifyBackendKind }; // keep the name exported for existing importers

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
    return resolveSpotifyBackendKind(
      this.config.backend,
      this.goPresent(),
      this.rustPresent(),
    );
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
