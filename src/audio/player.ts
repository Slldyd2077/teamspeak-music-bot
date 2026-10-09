import { spawn, execSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { accessSync, chmodSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpusEncoder, PCM_FRAME_BYTES, type Encoder } from "./encoder.js";
import {
  createRealtimePcmIngressTelemetry,
  updateRealtimePcmIngressTelemetry,
  type RealtimePcmIngressTelemetry,
} from "./realtime-voice-telemetry.js";
import type { Readable } from "node:stream";
import type { Logger } from "../logger.js";
import { collectFfmpegDiagnostics, type FfmpegDiagnostics } from "./ffmpeg-diagnostics.js";

const require = createRequire(import.meta.url);
const ffmpegPath: string | null = require("ffmpeg-static");

/** 全局 PID 追踪器，防止进程在类实例切换时沦为孤儿进程 （ */
const globalActivePids = new Set<number>();

function isExecutable(binPath: string): boolean {
  try {
    accessSync(binPath, constants.X_OK);
    return true;
  } catch {
    try {
      chmodSync(binPath, 0o755);
      accessSync(binPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function ffmpegWorks(bin: string): boolean {
  try {
    execSync(`"${bin}" -version`, { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const resolvedFfmpeg: string = (() => {
  if (ffmpegWorks("ffmpeg")) return "ffmpeg";
  const isWinPath = ffmpegPath ? /\\/.test(ffmpegPath) || ffmpegPath.endsWith(".exe") : false;
  const onWindows = process.platform === "win32";
  if (ffmpegPath && (onWindows === isWinPath)) {
    if (isExecutable(ffmpegPath) && ffmpegWorks(ffmpegPath)) return ffmpegPath;
  }
  return "ffmpeg";
})();

export function getFfmpegCommand(): string {
  return resolvedFfmpeg;
}

function safeFfmpegSpawnError(err: Error): Error {
  // Node spawn errors include spawnargs; Pino's Error serializer copies them,
  // including the signed input URL. Preserve a known OS category only.
  const allowedCodes = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EMFILE", "ENFILE", "ENOMEM", "EAGAIN", "EINVAL"]);
  const code = (err as NodeJS.ErrnoException).code;
  const safeCode = typeof code === "string" && allowedCodes.has(code) ? code : undefined;
  const safeError = new Error(`FFmpeg failed to start${safeCode ? ` (${safeCode})` : ""}`);
  if (safeCode) Object.assign(safeError, { code: safeCode });
  return safeError;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Old jdymusic CDN paths (e.g. /jdymusic/obj/...) RST direct Node-stack
// requests on Windows; same URL works when fetched via WinHTTP. Empirically,
// /jd-musicrep-ts/ and /ymusic/ paths do not have this restriction.
export function shouldUsePowerShellDownload(
  url: string,
  platform: string = process.platform,
): boolean {
  return platform === "win32" && url.includes("/jdymusic/");
}

/**
 * Absolute path to Windows PowerShell, resolved independent of PATH.
 *
 * The bot process can run with a PATH that omits System32\WindowsPowerShell
 * (e.g. launched from a stripped environment via the .bat launcher), which
 * makes a bare `spawn("powershell")` fail with ENOENT and leaves jdymusic
 * songs silently stuck at 0 / idle (the error is logged but never surfaced).
 * Resolve the canonical install location via %SystemRoot% and only fall back
 * to PATH lookup ("powershell") if it is somehow not there.
 */
const POWERSHELL_EXE: string = (() => {
  if (process.platform !== "win32") return "powershell";
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const full = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  try {
    accessSync(full, constants.F_OK);
    return full;
  } catch {
    return "powershell";
  }
})();

export function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export interface FfmpegInputOptions {
  realtime?: boolean;
}

export function buildFfmpegArgs(
  url: string,
  seekSeconds: number,
  options: FfmpegInputOptions = {},
): string[] {
  const args: string[] = ["-nostats"];
  let httpHostname: string | null = null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      httpHostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    }
  } catch {
    // Local paths and malformed URLs must not inherit CDN-specific options.
  }
  const isHttp = httpHostname !== null;
  const isBilibili = httpHostname !== null &&
    ["bilivideo.com", "bilivideo.cn", "bilibili.com", "szbdyd.com"].some(
      domain => httpHostname === domain || httpHostname.endsWith(`.${domain}`),
    );

  if (isBilibili) {
    args.push(
      "-headers",
      `Referer: https://www.bilibili.com\r\nUser-Agent: ${BROWSER_UA}\r\n`,
    );
  } else if (isHttp && (url.includes("music.126.net") || url.includes("music.163.com"))) {
    args.push(
      "-headers",
      `Referer: https://music.163.com/\r\nUser-Agent: ${BROWSER_UA}\r\n`,
    );
  }

  if (isHttp) {
    args.push(
      "-reconnect", "1",
      // Long B站 streams sit on a CDN whose session/token can close the
      // connection mid-file (premature EOF). Without this, FFmpeg treats that
      // EOF as end-of-input and stops ~partway through (see #89); with it, it
      // re-issues a Range request from the current offset to finish the stream.
      "-reconnect_at_eof", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "30",
      "-reconnect_on_network_error", "1",
      "-reconnect_on_http_error", "4xx,5xx",
    );
  }
  if (isHttp && options.realtime) {
    args.push(
      "-analyzeduration", "0",
      "-probesize", "32",
      "-fflags", "nobuffer",
      "-flags", "low_delay",
    );
  }
  // B站's CDN serves Range requests, so seek input-side: FFmpeg jumps straight
  // to the byte offset. Output-side seek would download and decode everything
  // before the target first — minutes for a resume deep into a 3-hour video
  // (#161), long enough to trip the stall watchdog.
  const inputSideSeek = isBilibili;
  if (seekSeconds > 0 && inputSideSeek) args.push("-ss", String(seekSeconds));
  args.push("-i", url);
  // Output-side seek (after -i): works on CDNs that reject Range/keyframe seeks (NetEase music.126.net).
  if (seekSeconds > 0 && !inputSideSeek) args.push("-ss", String(seekSeconds));
  args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "-");

  return args;
}

/**
 * Decide whether to end the current track when FFmpeg is still alive but has
 * produced no decodable audio for `emptyAttempts` consecutive frame ticks.
 *
 * - Near the song end we end quickly (`maxEmptyAttempts`): a normal EOF.
 * - Far from the end we wait much longer (`maxStallAttempts`) before giving up,
 *   so a transient buffer underrun on a healthy stream does NOT cause a false
 *   skip — but a genuinely dead stream (e.g. a long B站 stream whose CDN session
 *   expired mid-playback, #89) still recovers by advancing instead of going
 *   permanently silent.
 */
export function shouldEndOnStall(
  emptyAttempts: number,
  isNearEnd: boolean,
  maxEmptyAttempts: number,
  maxStallAttempts: number,
): boolean {
  if (isNearEnd && emptyAttempts >= maxEmptyAttempts) return true;
  if (emptyAttempts >= maxStallAttempts) return true;
  return false;
}

/**
 * Maps a 0-100 volume value to a linear PCM gain factor (#84).
 *
 * Continuous and strictly monotonic over [0,100]: 0 at vol 0 and exactly 1.0 at
 * vol 100. The previous mapping was a two-piece step — gain = (vol/100)*0.2 for
 * vol<100 (so the whole 0-99 range only spanned 0..0.198, making 80->99 feel
 * flat) then a raw passthrough at vol===100 (a ~5x jump). This single curve keeps
 * the low end gentle but ramps smoothly toward full loudness near the top, so the
 * slider feels proportional with no dead zone and no discontinuity at 100.
 */
export function volumeToFactor(volume: number): number {
  const x = Math.max(0, Math.min(100, volume)) / 100;
  return 0.2 * x + 0.8 * Math.pow(x, 8);
}

export interface PlayerEvents {
  frame: (opusFrame: Buffer, metadata: PlayerFrameMetadata) => void;
  trackEnd: () => void;
  error: (err: Error) => void;
}

export type PlayerState = "idle" | "playing" | "paused";
export type PlaybackMode = "media" | "realtime";

const FRAME_DURATION_MS = 20;
const MEDIA_BUFFER_HIGH_WATER = 640 * 1024;
const MEDIA_BUFFER_LOW_WATER = 256 * 1024;
const REALTIME_MAX_BUFFER_FRAMES = 12;
const REALTIME_MAX_BUFFER_BYTES = PCM_FRAME_BYTES * REALTIME_MAX_BUFFER_FRAMES;
const SOUND_EFFECT_MAX_SECONDS = 7;
const SOUND_EFFECT_DECODER_TIMEOUT_MS = 15_000;
const SOUND_EFFECT_PATH_PATTERN =
  /^\/api\/music\/voice\/entry-sound\/stream\/[A-Za-z0-9_-]{40,64}$/;
export const SOUND_EFFECT_MAX_PCM_BYTES =
  SOUND_EFFECT_MAX_SECONDS * 48_000 * 2 * 2;

export function normalizeSoundEffectTrustedOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== "/" && parsed.pathname !== "") ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isValidSoundEffectUrl(
  value: unknown,
  trustedOrigin?: string,
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const normalizedTrustedOrigin = trustedOrigin === undefined
      ? undefined
      : normalizeSoundEffectTrustedOrigin(trustedOrigin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      (normalizedTrustedOrigin === undefined ||
        (normalizedTrustedOrigin !== null && parsed.origin === normalizedTrustedOrigin)) &&
      SOUND_EFFECT_PATH_PATTERN.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export interface AudioPlayerDependencies {
  spawnSoundEffect?: (
    command: string,
    args: string[],
    options: { stdio: ["ignore", "pipe", "pipe"] },
  ) => ChildProcess;
}

export class SoundEffectReplacedError extends Error {
  constructor() {
    super("Sound effect replaced by a newer request");
    this.name = "SoundEffectReplacedError";
  }
}

export function buildSoundEffectFfmpegArgs(url: string): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "2",
    "-i", url,
    "-t", String(SOUND_EFFECT_MAX_SECONDS),
    "-vn",
    "-sn",
    "-dn",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "-acodec", "pcm_s16le",
    "-",
  ];
}

export function mixPcmFrames(primary: Buffer, overlay: Buffer): Buffer {
  const outputLength = Math.max(primary.length, overlay.length);
  const output = Buffer.alloc(outputLength);
  for (let offset = 0; offset + 1 < outputLength; offset += 2) {
    const primarySample = offset + 1 < primary.length
      ? primary.readInt16LE(offset)
      : 0;
    const overlaySample = offset + 1 < overlay.length
      ? overlay.readInt16LE(offset)
      : 0;
    output.writeInt16LE(
      Math.max(-32_768, Math.min(32_767, primarySample + overlaySample)),
      offset,
    );
  }
  return output;
}

export function isNearPlaybackEnd(
  mode: PlaybackMode,
  durationSeconds: number,
  elapsedSeconds: number,
): boolean {
  if (mode === "realtime") return false;
  return durationSeconds > 0 ? (durationSeconds - elapsedSeconds) <= 5 : true;
}

export interface PlaybackBufferPolicy {
  highWaterBytes: number;
  lowWaterBytes: number;
  maxBufferedMs: number;
  dropOldest: boolean;
  pauseDecoder: boolean;
}

export function getPlaybackBufferPolicy(mode: PlaybackMode): PlaybackBufferPolicy {
  if (mode === "realtime") {
    return {
      highWaterBytes: REALTIME_MAX_BUFFER_BYTES,
      lowWaterBytes: 0,
      maxBufferedMs: REALTIME_MAX_BUFFER_FRAMES * FRAME_DURATION_MS,
      dropOldest: true,
      pauseDecoder: false,
    };
  }
  return {
    highWaterBytes: MEDIA_BUFFER_HIGH_WATER,
    lowWaterBytes: MEDIA_BUFFER_LOW_WATER,
    maxBufferedMs: (MEDIA_BUFFER_HIGH_WATER / PCM_FRAME_BYTES) * FRAME_DURATION_MS,
    dropOldest: false,
    pauseDecoder: true,
  };
}

export interface TrimmedPcmBuffer {
  buffer: Buffer;
  droppedBytes: number;
}

export interface PlaybackDiagnostics {
  mode: PlaybackMode;
  bufferedMs: number;
  maxBufferedMs: number;
  droppedMs: number;
  decoderPaused: boolean;
  decodedSpeechStarts: number;
  lastDecodedPcmAt: number;
  lastDecodedSpeechStartedAt: number;
}

export interface PlayerFrameMetadata {
  mode: PlaybackMode;
  voiced: boolean;
  diagnostics: PlaybackDiagnostics;
}

function pcmBytesToMs(bytes: number): number {
  return Math.round((Math.max(0, bytes) / PCM_FRAME_BYTES) * FRAME_DURATION_MS);
}

export function buildPlaybackDiagnostics(
  mode: PlaybackMode,
  bufferedBytes: number,
  droppedBytes: number,
  decoderPaused: boolean,
  ingress: RealtimePcmIngressTelemetry = createRealtimePcmIngressTelemetry(),
): PlaybackDiagnostics {
  return {
    mode,
    bufferedMs: pcmBytesToMs(bufferedBytes),
    maxBufferedMs: getPlaybackBufferPolicy(mode).maxBufferedMs,
    droppedMs: pcmBytesToMs(droppedBytes),
    decoderPaused,
    decodedSpeechStarts: ingress.speechStarts,
    lastDecodedPcmAt: ingress.lastPcmAt,
    lastDecodedSpeechStartedAt: ingress.lastSpeechStartedAt,
  };
}

export function trimRealtimePcmBuffer(
  buffer: Buffer,
  maxBytes = REALTIME_MAX_BUFFER_BYTES,
): TrimmedPcmBuffer {
  const alignedMaxBytes = Math.max(
    PCM_FRAME_BYTES,
    Math.floor(maxBytes / PCM_FRAME_BYTES) * PCM_FRAME_BYTES,
  );
  if (buffer.length <= alignedMaxBytes) return { buffer, droppedBytes: 0 };

  const excessBytes = buffer.length - alignedMaxBytes;
  const droppedBytes = Math.ceil(excessBytes / PCM_FRAME_BYTES) * PCM_FRAME_BYTES;
  return {
    buffer: buffer.subarray(Math.min(droppedBytes, buffer.length)),
    droppedBytes: Math.min(droppedBytes, buffer.length),
  };
}

export function isPcmFrameVoiced(frame: Buffer, peakThreshold = 256): boolean {
  for (let offset = 0; offset + 1 < frame.length; offset += 2) {
    if (Math.abs(frame.readInt16LE(offset)) >= peakThreshold) return true;
  }
  return false;
}

export class AudioPlayer extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private ffmpegDiagnostics: FfmpegDiagnostics | null = null;
  private readonly intentionalCleanup = new WeakSet<ChildProcess>();
  private encoder: Encoder;
  private state: PlayerState = "idle";
  private volume = 75;
  /**
   * A transient gain envelope layered on top of the persisted user volume.
   * Voice ducking drives this value; keeping it separate means a temporary
   * attenuation can never leak into the saved volume setting.
   */
  private duckingRampStartGain = 1;
  private duckingTargetGain = 1;
  private duckingRampStartedAt = 0;
  private duckingRampDurationMs = 0;
  private pcmBuffer: Buffer = Buffer.alloc(0);
  private logger: Logger;
  private frameLoopRunning = false;
  private nextFrameTime = 0;
  private currentUrl = "";
  private seekOffset = 0;
  private framesPlayed = 0;
  private sessionId = 0;
  private playbackMode: PlaybackMode = "media";
  private realtimeDroppedBytes = 0;
  private realtimeIngress = createRealtimePcmIngressTelemetry();
  private realtimeIngressCarry = Buffer.alloc(0);
  private ffmpegPaused = false;
  private spawnFailed = false;
  private consecutiveFailures = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;
  // Media-mode buffer water marks live at module scope (MEDIA_BUFFER_*), where
  // the buffer-policy helpers can use them; these aliases keep the historical
  // static names working for the external PCM path (playPcmStream).
  private static readonly BUFFER_HIGH_WATER = MEDIA_BUFFER_HIGH_WATER;
  private static readonly BUFFER_LOW_WATER = MEDIA_BUFFER_LOW_WATER;
  private healthyFrames = 0;
  private static readonly HEALTHY_FRAME_RESET = 50; // ~1 second of audio
  private downloader: ChildProcess | null = null;
  private currentTempDir: string | null = null;
  private emptyFrameAttempts = 0;
  private static readonly MAX_EMPTY_ATTEMPTS = 250; // ~5秒的20ms帧循环（增加容错）
  // Far-from-end stall watchdog (#89): if FFmpeg is alive but produces no audio
  // for this many consecutive frame ticks (~60s at 20ms/frame), treat the stream
  // as dead and advance instead of staying silent forever. Set high so a normal
  // transient underrun never trips it.
  private static readonly MAX_STALL_ATTEMPTS = 3000;
  private currentSongDuration = 0; // 当前歌曲总时长（秒）

  // Independent one-shot decoder mixed into the outgoing PCM timeline. It is
  // deliberately separate from ffmpeg/pcmBuffer/sessionId so an entrance
  // effect cannot stop, seek, clear, or advance the primary player.
  private soundEffectFfmpeg: ChildProcess | null = null;
  private soundEffectBuffer = Buffer.alloc(0);
  private soundEffectSessionId = 0;
  private soundEffectDecodedBytes = 0;
  private soundEffectTimeout: ReturnType<typeof setTimeout> | null = null;
  private soundEffectStartupResolve: (() => void) | null = null;
  private soundEffectStartupReject: ((error: Error) => void) | null = null;
  private readonly spawnSoundEffect: NonNullable<
    AudioPlayerDependencies["spawnSoundEffect"]
  >;

  // --- External PCM mode (Stage 2: go-librespot Spotify sidecar) ---
  // When true, PCM arrives from a long-lived external Readable instead of a
  // per-URL ffmpeg: this.ffmpeg stays null, and the underrun-driven trackEnd
  // branches are suppressed (advance is driven by the controller, not EOF).
  //
  // CORRECTION C2: externalStream is the backend's LONG-LIVED, SHARED ffmpeg
  // stdout (one stream reused across every track). Teardown must DETACH (remove
  // the listeners we added + pause), never destroy it. We keep references to the
  // exact handler functions so detach can removeListener precisely.
  private externalMode = false;
  private externalStream: Readable | null = null;
  private onExternalEnd: (() => void) | null = null;
  private externalDataHandler: ((chunk: Buffer) => void) | null = null;
  private externalEndHandler: (() => void) | null = null;
  private externalErrorHandler: ((err: Error) => void) | null = null;

  constructor(logger: Logger, dependencies: AudioPlayerDependencies = {}) {
    super();
    this.encoder = createOpusEncoder();
    this.logger = logger;
    this.spawnSoundEffect = dependencies.spawnSoundEffect ?? spawn;
  }

  play(
    url: string,
    seekSeconds = 0,
    songDuration = 0,
    options: FfmpegInputOptions = {},
  ): void {
    // 1. 停止当前所有播放，自增 sessionId 屏蔽旧回调 （
    this.stop();

    const currentSessionId = this.sessionId; 
    this.playbackMode = options.realtime ? "realtime" : "media";
    this.realtimeDroppedBytes = 0;
    this.realtimeIngress = createRealtimePcmIngressTelemetry();
    this.realtimeIngressCarry = Buffer.alloc(0);
    this.currentUrl = url;
    this.seekOffset = seekSeconds;
    this.framesPlayed = 0;
    this.healthyFrames = 0;
    this.ffmpegPaused = false;
    this.spawnFailed = false;
    this.emptyFrameAttempts = 0;
    this.currentSongDuration = songDuration;

    if (this.consecutiveFailures >= AudioPlayer.MAX_CONSECUTIVE_FAILURES) {
      this.logger.error({ failures: this.consecutiveFailures }, "FFmpeg failures limit reached");
      this.state = "idle";
      this.emit("error", new Error("ffmpeg unavailable"));
      return;
    }

    if (shouldUsePowerShellDownload(url)) {
      this.playViaPowerShellDownload(url, seekSeconds, currentSessionId);
      return;
    }

    const args = buildFfmpegArgs(url, seekSeconds, options);

    const ffmpegBin = getFfmpegCommand();
    this.ffmpeg = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const child = this.ffmpeg;
    const diagnostics = collectFfmpegDiagnostics(child.stderr);
    this.ffmpegDiagnostics = diagnostics;
    
    const currentPid = this.ffmpeg.pid;
    if (currentPid) {
      globalActivePids.add(currentPid);
      this.logger.debug({ pid: currentPid, sessionId: currentSessionId }, "FFmpeg spawned");
    }

    this.ffmpeg.stdout!.on("data", (chunk: Buffer) => {
      // 2. 严格校验 sessionId，防止老进程的数据混入新播放请求 （
      if (this.sessionId !== currentSessionId) {
        return;
      }
      
      if (this.playbackMode === "realtime") this.observeRealtimePcm(chunk);
      const combined = Buffer.concat([this.pcmBuffer, chunk]);
      if (this.playbackMode === "realtime") {
        const trimmed = trimRealtimePcmBuffer(combined);
        this.pcmBuffer = trimmed.buffer;
        this.realtimeDroppedBytes += trimmed.droppedBytes;
      } else {
        this.pcmBuffer = combined;
      }
      if (this.playbackMode === "media"
        && this.pcmBuffer.length > MEDIA_BUFFER_HIGH_WATER
        && !this.ffmpegPaused
        && this.ffmpeg?.stdout) {
        this.ffmpeg.stdout.pause();
        this.ffmpegPaused = true;
      }
    });

    this.ffmpeg.on("exit", (code, signal) => {
      if (currentPid) globalActivePids.delete(currentPid);
      
      // 只有当前会话的进程结束才置空变量
      if (this.sessionId === currentSessionId) {
        this.ffmpeg = null;
      }
    });

    // close follows stderr's end, so final unterminated diagnostics are ready.
    this.ffmpeg.on("close", (code, signal) => {
      const context = { pid: currentPid, sessionId: currentSessionId, code, signal };
      if (!this.intentionalCleanup.has(child) && ((typeof code === "number" && code !== 0) || signal !== null)) {
        this.logger.warn({ ...context, stderr: diagnostics.getTail() }, "FFmpeg exited");
      } else {
        this.logger.info(context, "FFmpeg exited");
      }
    });

    this.ffmpeg.on("error", (err) => {
      if (this.sessionId === currentSessionId) {
        this.spawnFailed = true;
        this.consecutiveFailures++;
        this.emit("error", safeFfmpegSpawnError(err));
      }
    });

    this.state = "playing";
    this.startFrameLoop();
  }

  playLive(url: string): void {
    this.play(url, 0, 0, { realtime: true });
  }

  /**
   * Decode and overlay a short entrance sound without altering primary playback.
   * A newer request replaces the previous effect; decoder/runtime failures stay
   * isolated and never emit the player's track-advancing `error` event.
   */
  playSoundEffect(url: string): Promise<void> {
    if (!isValidSoundEffectUrl(url)) {
      return Promise.reject(new Error("A valid http(s) sound effect URL is required"));
    }

    this.cancelSoundEffect(new SoundEffectReplacedError());
    const effectSessionId = this.soundEffectSessionId;
    this.soundEffectDecodedBytes = 0;

    let decoder: ChildProcess;
    try {
      decoder = this.spawnSoundEffect(getFfmpegCommand(), buildSoundEffectFfmpegArgs(url), {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error("Sound effect decoder failed");
      this.logger.warn({ err }, "Sound effect decoder failed to start");
      return Promise.reject(err);
    }

    this.soundEffectFfmpeg = decoder;
    const decoderPid = decoder.pid;
    if (decoderPid) globalActivePids.add(decoderPid);

    decoder.stdout?.on("data", (chunk: Buffer) => {
      if (effectSessionId !== this.soundEffectSessionId) return;
      const remainingBytes = SOUND_EFFECT_MAX_PCM_BYTES - this.soundEffectDecodedBytes;
      if (remainingBytes <= 0) return;
      const accepted = chunk.subarray(0, remainingBytes);
      this.soundEffectDecodedBytes += accepted.length;
      this.soundEffectBuffer = Buffer.concat([this.soundEffectBuffer, accepted]);
      if (accepted.length > 0 && this.soundEffectStartupResolve) {
        const resolve = this.soundEffectStartupResolve;
        this.soundEffectStartupResolve = null;
        this.soundEffectStartupReject = null;
        resolve();
      }
    });

    // Drain diagnostics so a noisy decoder cannot block on a full stderr pipe.
    // Do not log it: ffmpeg commonly repeats the signed capability URL there.
    decoder.stderr?.resume();

    decoder.on("exit", (code, signal) => {
      if (decoderPid) globalActivePids.delete(decoderPid);
      if (effectSessionId !== this.soundEffectSessionId) return;
      if (this.soundEffectFfmpeg === decoder) this.soundEffectFfmpeg = null;
      this.clearSoundEffectTimeout();
      if (this.soundEffectStartupReject) {
        const reject = this.soundEffectStartupReject;
        this.soundEffectStartupResolve = null;
        this.soundEffectStartupReject = null;
        reject(new Error(
          code === 0
            ? "Sound effect produced no decodable audio"
            : "Sound effect decoder failed",
        ));
      }
      if (code !== 0 && code !== null) {
        this.logger.warn(
          { code, signal },
          "Sound effect decoder exited unsuccessfully",
        );
      }
    });

    this.soundEffectTimeout = setTimeout(() => {
      if (effectSessionId !== this.soundEffectSessionId) return;
      this.logger.warn("Sound effect decoder timed out");
      if (this.soundEffectStartupReject) {
        const reject = this.soundEffectStartupReject;
        this.soundEffectStartupResolve = null;
        this.soundEffectStartupReject = null;
        reject(new Error("Sound effect decoder timed out"));
      }
      this.finishSoundEffectDecoder(decoder);
    }, SOUND_EFFECT_DECODER_TIMEOUT_MS);
    this.soundEffectTimeout.unref?.();

    this.startFrameLoop();
    return new Promise<void>((resolve, reject) => {
      this.soundEffectStartupResolve = resolve;
      this.soundEffectStartupReject = reject;
      decoder.once("error", (error) => {
        if (effectSessionId !== this.soundEffectSessionId) return;
        this.soundEffectStartupResolve = null;
        this.soundEffectStartupReject = null;
        if (this.soundEffectFfmpeg === decoder) this.soundEffectFfmpeg = null;
        this.clearSoundEffectTimeout();
        this.logger.warn({ err: error }, "Sound effect decoder failed");
        reject(error);
      });
    });
  }

  private clearSoundEffectTimeout(): void {
    if (!this.soundEffectTimeout) return;
    clearTimeout(this.soundEffectTimeout);
    this.soundEffectTimeout = null;
  }

  private finishSoundEffectDecoder(decoder: ChildProcess): void {
    if (this.soundEffectFfmpeg !== decoder) return;
    this.soundEffectFfmpeg = null;
    const pid = decoder.pid;
    if (pid) this.forceCleanup(decoder, pid);
    else {
      try { decoder.kill("SIGTERM"); } catch { /* already exited */ }
    }
    this.clearSoundEffectTimeout();
  }

  private cancelSoundEffect(reason?: Error): void {
    this.soundEffectSessionId++;
    this.soundEffectStartupReject?.(reason ?? new Error("Sound effect cancelled"));
    this.soundEffectStartupResolve = null;
    this.soundEffectStartupReject = null;
    this.soundEffectBuffer = Buffer.alloc(0);
    this.soundEffectDecodedBytes = 0;
    this.clearSoundEffectTimeout();
    const decoder = this.soundEffectFfmpeg;
    this.soundEffectFfmpeg = null;
    if (!decoder) return;
    const pid = decoder.pid;
    if (pid) this.forceCleanup(decoder, pid);
    else {
      try { decoder.kill("SIGTERM"); } catch { /* already exited */ }
    }
  }

  private hasSoundEffectOutput(): boolean {
    return this.soundEffectFfmpeg !== null || this.soundEffectBuffer.length > 0;
  }

  private takeSoundEffectFrame(): Buffer | null {
    if (this.soundEffectBuffer.length >= PCM_FRAME_BYTES) {
      const frame = Buffer.from(this.soundEffectBuffer.subarray(0, PCM_FRAME_BYTES));
      this.soundEffectBuffer = this.soundEffectBuffer.subarray(PCM_FRAME_BYTES);
      return frame;
    }
    if (this.soundEffectFfmpeg || this.soundEffectBuffer.length === 0) return null;
    const finalFrame = Buffer.alloc(PCM_FRAME_BYTES);
    this.soundEffectBuffer.copy(finalFrame);
    this.soundEffectBuffer = Buffer.alloc(0);
    return finalFrame;
  }

  private playViaPowerShellDownload(url: string, seekSeconds: number, sessionId: number): void {
    const tempDir = mkdtempSync(join(tmpdir(), "tsbot-jdymusic-"));
    const tempFile = join(tempDir, "song.audio");
    this.currentTempDir = tempDir;

    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "$wc = New-Object System.Net.WebClient",
      "$wc.Headers.Add('User-Agent', $env:DL_UA)",
      "$wc.Headers.Add('Referer', $env:DL_REFERER)",
      "$wc.DownloadFile($env:DL_URL, $env:DL_OUT)",
    ].join("; ");

    this.logger.debug({ sessionId, tempFile }, "Downloading via PowerShell (jdymusic CDN)");

    const ps = spawn(
      POWERSHELL_EXE,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      {
        env: {
          ...process.env,
          DL_URL: url,
          DL_OUT: tempFile,
          DL_UA: BROWSER_UA,
          DL_REFERER: "https://music.163.com/",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.downloader = ps;

    const diagnostics = collectFfmpegDiagnostics(ps.stderr);

    ps.on("exit", (code, signal) => {
      if (this.sessionId !== sessionId) {
        cleanupTempDir(tempDir);
        return;
      }
      this.downloader = null;
      if (code !== 0) {
        this.spawnFailed = true;
        this.consecutiveFailures++;
        this.state = "idle";
        cleanupTempDir(tempDir);
        this.currentTempDir = null;
        this.emit("error", new Error(`PowerShell download exited ${code}`));
        return;
      }
      this.spawnFfmpegFromFile(tempFile, seekSeconds, sessionId);
    });

    ps.on("close", (code, signal) => {
      if (!this.intentionalCleanup.has(ps) && ((typeof code === "number" && code !== 0) || signal !== null)) {
        this.logger.warn({ pid: ps.pid, sessionId, code, signal, stderr: diagnostics.getTail() }, "PowerShell download failed");
      }
    });

    ps.on("error", (err) => {
      if (this.sessionId !== sessionId) return;
      this.downloader = null;
      this.spawnFailed = true;
      this.consecutiveFailures++;
      cleanupTempDir(tempDir);
      this.currentTempDir = null;
      this.emit("error", err);
    });

    // Mark playing but DO NOT start the frame loop here — the loop's
    // "no ffmpeg + empty buffer → trackEnd" branch would fire on the very
    // first tick, before the PowerShell download even completes. The
    // frame loop is started inside spawnFfmpegFromFile() once ffmpeg is
    // alive and producing PCM.
    this.state = "playing";
  }

  private spawnFfmpegFromFile(tempFile: string, seekSeconds: number, sessionId: number): void {
    if (this.sessionId !== sessionId) {
      if (this.currentTempDir) {
        cleanupTempDir(this.currentTempDir);
        this.currentTempDir = null;
      }
      return;
    }

    const args = buildFfmpegArgs(tempFile, seekSeconds);
    const ffmpegBin = getFfmpegCommand();
    this.ffmpeg = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const child = this.ffmpeg;
    const diagnostics = collectFfmpegDiagnostics(child.stderr);
    this.ffmpegDiagnostics = diagnostics;

    const currentPid = this.ffmpeg.pid;
    if (currentPid) {
      globalActivePids.add(currentPid);
      this.logger.debug({ pid: currentPid, sessionId }, "FFmpeg spawned (from temp file)");
    }
    const tempDirToCleanup = this.currentTempDir;

    this.ffmpeg.stdout!.on("data", (chunk: Buffer) => {
      if (this.sessionId !== sessionId) return;
      this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);
      if (this.pcmBuffer.length > MEDIA_BUFFER_HIGH_WATER && !this.ffmpegPaused && this.ffmpeg?.stdout) {
        this.ffmpeg.stdout.pause();
        this.ffmpegPaused = true;
      }
    });

    this.ffmpeg.on("exit", (code, signal) => {
      if (currentPid) globalActivePids.delete(currentPid);
      if (this.sessionId === sessionId) {
        this.ffmpeg = null;
        if (this.currentTempDir === tempDirToCleanup) this.currentTempDir = null;
      }
      if (tempDirToCleanup) cleanupTempDir(tempDirToCleanup);
    });

    this.ffmpeg.on("close", (code, signal) => {
      const context = { pid: currentPid, sessionId, code, signal };
      if (!this.intentionalCleanup.has(child) && ((typeof code === "number" && code !== 0) || signal !== null)) {
        this.logger.warn({ ...context, stderr: diagnostics.getTail() }, "FFmpeg exited");
      } else {
        this.logger.info(context, "FFmpeg exited");
      }
    });

    this.ffmpeg.on("error", (err) => {
      if (this.sessionId === sessionId) {
        this.spawnFailed = true;
        this.consecutiveFailures++;
        this.emit("error", safeFfmpegSpawnError(err));
      }
    });

    // Now that ffmpeg is producing PCM, run the frame loop.
    this.startFrameLoop();
  }

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
   *
   * CORRECTION C2: the readable is the backend's long-lived, SHARED ffmpeg
   * stdout reused across every track — a gapless track change is just LATER PCM
   * on this SAME already-attached stream (no re-attach). Teardown DETACHES
   * (removes our listeners + pauses); it never destroys the shared stream.
   */
  playPcmStream(readable: Readable, opts: { onExternalEnd?: () => void } = {}): void {
    // 1. Fence current playback: stop() bumps sessionId, clears pcmBuffer, kills
    //    any ffmpeg, and DETACHES (never destroys) any prior external stream.
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
    // stale sidecar PCM can't leak into a new track after stop()/skip. Handler
    // refs are stored so detach can remove exactly these listeners (C2).
    const onData = (chunk: Buffer): void => {
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
    };
    const onEnd = (): void => {
      if (this.sessionId !== currentSessionId) return;
      this.onExternalEnd?.();
    };
    const onError = (err: Error): void => {
      if (this.sessionId !== currentSessionId) return;
      this.logger.warn({ err }, "External PCM stream error");
      this.onExternalEnd?.();
    };

    this.externalDataHandler = onData;
    this.externalEndHandler = onEnd;
    this.externalErrorHandler = onError;

    readable.on("data", onData);
    readable.on("end", onEnd);
    readable.on("error", onError);

    // CORRECTION C1: explicitly resume a re-attached, previously-paused Readable.
    // The backend's SHARED stdout is reused across every track; a prior non-spotify
    // advance ran stop() -> detachExternalStream() which pause()d it (state.flowing =
    // false). Node's Readable.on('data') only auto-resumes when flowing !== false, so
    // re-attaching a paused stream would leave it stuck: onData never fires, pcmBuffer
    // stays empty, and a later Spotify track plays only silence. resume() is safe/
    // idempotent on a first attach (never-paused/already-flowing) stream.
    readable.resume();

    this.state = "playing";
    this.startFrameLoop();
  }

  /**
   * CORRECTION C2: DETACH, never destroy. The external readable is the backend's
   * long-lived, SHARED ffmpeg stdout reused across every track; destroying it
   * would kill the sidecar pipe for all future tracks. Remove only the listeners
   * WE added and pause the flow so stale PCM stops landing in pcmBuffer, then
   * clear the external-mode state.
   */
  private detachExternalStream(): void {
    const stream = this.externalStream;
    if (stream) {
      if (this.externalDataHandler) stream.off("data", this.externalDataHandler);
      if (this.externalEndHandler) stream.off("end", this.externalEndHandler);
      if (this.externalErrorHandler) stream.off("error", this.externalErrorHandler);
      try {
        stream.pause();
      } catch {
        /* best-effort: never destroy the shared sidecar stream */
      }
    }
    this.externalDataHandler = null;
    this.externalEndHandler = null;
    this.externalErrorHandler = null;
    this.externalStream = null;
    this.externalMode = false;
    this.onExternalEnd = null;
  }

  stop(): void {
    // 3. 递增 ID 是最有效的逻辑“隔离墙”
    this.sessionId++; 
    this.frameLoopRunning = false;
    
    // 立即清空缓冲区，确保切歌瞬间静音 （
    this.pcmBuffer = Buffer.alloc(0);
    this.ffmpegDiagnostics = null;

    if (this.ffmpeg) {
      const procToKill = this.ffmpeg;
      const pidToKill = procToKill.pid;
      this.ffmpeg = null;

      if (pidToKill) {
        this.forceCleanup(procToKill, pidToKill);
      }
    }

    if (this.downloader) {
      const ps = this.downloader;
      this.downloader = null;
      this.intentionalCleanup.add(ps);
      try { ps.kill("SIGTERM"); } catch { /* already gone */ }
    }

    if (this.currentTempDir) {
      cleanupTempDir(this.currentTempDir);
      this.currentTempDir = null;
    }

    // CORRECTION C2: tear down external mode by DETACHING (remove our listeners +
    // pause) — never destroy the shared, long-lived sidecar stream. The
    // sessionId++ above already fences the external data/end/error handlers.
    this.detachExternalStream();
    this.cancelSoundEffect();

    this.ffmpegPaused = false;
    this.spawnFailed = false;
    this.playbackMode = "media";
    this.realtimeDroppedBytes = 0;
    this.realtimeIngress = createRealtimePcmIngressTelemetry();
    this.realtimeIngressCarry = Buffer.alloc(0);
    this.state = "idle";
    this.currentUrl = "";
    this.seekOffset = 0;
    this.framesPlayed = 0;
    this.healthyFrames = 0;
  }

  private forceCleanup(proc: ChildProcess, pid: number): void {
    this.intentionalCleanup.add(proc);
    if (!globalActivePids.has(pid)) return;

    try {
      proc.kill("SIGTERM");
    } catch (e) { /* ignore */ }

    const killTimeout = setTimeout(() => {
      try {
        process.kill(pid, 0); 
        process.kill(pid, "SIGKILL");
      } catch (e) {
      } finally {
        globalActivePids.delete(pid);
      }
    }, 1500);

    proc.unref();
    proc.once("exit", () => {
      clearTimeout(killTimeout);
      globalActivePids.delete(pid);
    });
  }

  private startFrameLoop(): void {
    if (this.frameLoopRunning) return;
    this.frameLoopRunning = true;
    this.nextFrameTime = performance.now();
    this.scheduleNextFrame();
  }

  private scheduleNextFrame(): void {
    if (!this.frameLoopRunning) return;
    const loopSessionId = this.sessionId;
    this.nextFrameTime += FRAME_DURATION_MS;
    const delay = Math.max(0, this.nextFrameTime - performance.now());

    setTimeout(() => {
      // 这里的校验能防止旧的定时器回调处理新 Session 的逻辑 （
      if (loopSessionId !== this.sessionId || !this.frameLoopRunning) return;

      const framesBeforeTick = this.framesPlayed;
      if (this.state === "playing" || this.hasSoundEffectOutput()) this.sendNextFrame();
      else if (this.state === "paused") this.nextFrameTime = performance.now();
      const frameSent = this.framesPlayed > framesBeforeTick;

      // 检测pcmBuffer不足PCM_FRAME_BYTES导致连续循环卡死：
      // 条件1: FFmpeg仍在运行但缓冲区不足一帧，且连续多次无法获取数据
      // 条件2: 已播放时间接近歌曲结尾（最后5秒内）或未知时长
      const elapsed = this.getElapsed();
      const isNearEnd = isNearPlaybackEnd(
        this.playbackMode,
        this.currentSongDuration,
        elapsed,
      );
      
      // External mode: the sidecar PCM stream is continuous and never EOFs per
      // song; a transient underrun must NOT end the track (advance is driven by
      // the controller). Skip BOTH drain/stall branches while externalMode.
      //
      // R3-4: gate BOTH end-detection branches on state==="playing". While paused
      // the loop still ticks (so a resumed stream can refill), but it must NOT
      // accumulate stall attempts or emit trackEnd — otherwise pausing a stalled/
      // unknown-duration stream would auto-advance ~5s later. Because the if is
      // now false while paused, the else resets emptyFrameAttempts to 0, so a
      // resumed healthy stream starts fresh and never ends instantly.
      // A healthy paced source can supply exactly one frame per tick, leaving
      // no reserve after sendNextFrame. Count only ticks without emitted audio.
      if (this.state === "playing" && !this.externalMode && !frameSent && this.ffmpeg !== null && this.pcmBuffer.length < PCM_FRAME_BYTES) {
        this.emptyFrameAttempts++;
        
        // End the track when FFmpeg has gone silent: quickly if we're near the
        // end (normal EOF), or after a much longer stall window if we're not
        // (a dead/expired stream — #89 — so playback recovers instead of going
        // permanently silent).
        if (
          shouldEndOnStall(
            this.emptyFrameAttempts,
            isNearEnd,
            AudioPlayer.MAX_EMPTY_ATTEMPTS,
            AudioPlayer.MAX_STALL_ATTEMPTS,
          )
        ) {
          this.logger.info({
            sessionId: this.sessionId,
            emptyAttempts: this.emptyFrameAttempts,
            bufferSize: this.pcmBuffer.length,
            elapsed: Math.round(elapsed),
            duration: this.currentSongDuration,
            remaining: Math.round(this.currentSongDuration - elapsed),
            nearEnd: isNearEnd,
            stderr: this.ffmpegDiagnostics?.getTail() ?? "",
          }, "FFmpeg stopped outputting data, ending track");
          this.frameLoopRunning = false;
          // The outer gate guarantees state==="playing" here, so no !=="idle"
          // guard is needed: end the track directly.
          this.state = "idle";
          // 清理FFmpeg进程
          if (this.ffmpeg) {
            const procToKill = this.ffmpeg;
            const pidToKill = procToKill.pid;
            this.ffmpeg = null;
            if (pidToKill) {
              this.forceCleanup(procToKill, pidToKill);
            }
          }
          this.consecutiveFailures = 0;
          this.emit("trackEnd");
          return;
        }
      } else {
        // 成功获取数据或FFmpeg已结束，重置计数器
        this.emptyFrameAttempts = 0;
      }

      // R3-4: likewise gated on state==="playing" — a drained/EOF'd stream must
      // not emit trackEnd while paused; end-detection resumes on resume().
      if (this.state === "playing" && !this.externalMode && !this.ffmpeg && this.pcmBuffer.length < PCM_FRAME_BYTES) {
        this.frameLoopRunning = false;
        // Outer gate guarantees state==="playing"; end directly (no !=="idle" guard).
        this.state = "idle";
        if (!this.spawnFailed) {
          this.consecutiveFailures = 0;
          this.emit("trackEnd");
        }
        return;
      }
      if (this.state === "idle" && !this.hasSoundEffectOutput()) {
        this.frameLoopRunning = false;
        return;
      }
      this.scheduleNextFrame();
    }, delay);
  }

  private sendNextFrame(): void {
    const canConsumePrimary =
      this.state === "playing" && this.pcmBuffer.length >= PCM_FRAME_BYTES;
    if (!canConsumePrimary && !this.hasSoundEffectOutput()) {
      // External mode: the sidecar PCM stream is long-lived and must NOT end on
      // a transient underrun. Emit an encoded silence frame so the 20ms voice
      // timeline stays continuous instead of returning (which would desync TS).
      if (this.externalMode) this.emitSilenceFrame();
      return;
    }

    const primaryFrame = canConsumePrimary
      ? Buffer.from(this.pcmBuffer.subarray(0, PCM_FRAME_BYTES))
      : null;
    if (canConsumePrimary) this.pcmBuffer = this.pcmBuffer.subarray(PCM_FRAME_BYTES);
    const effectFrame = this.takeSoundEffectFrame();
    if (!primaryFrame && !effectFrame) {
      if (this.externalMode && this.state === "playing") this.emitSilenceFrame();
      return;
    }

    if (this.ffmpegPaused && this.pcmBuffer.length < MEDIA_BUFFER_LOW_WATER) {
      if (this.externalMode && this.externalStream) {
        this.externalStream.resume();
        this.ffmpegPaused = false;
      } else if (this.ffmpeg?.stdout) {
        this.ffmpeg.stdout.resume();
        this.ffmpegPaused = false;
      }
    }

    try {
      const volumeAt = performance.now();
      const adjustedPrimary = this.applyVolume(
        primaryFrame ?? Buffer.alloc(PCM_FRAME_BYTES),
        volumeAt,
      );
      const adjustedEffect = effectFrame
        ? this.applyVolume(effectFrame, volumeAt)
        : null;
      const adjusted = adjustedEffect
        ? mixPcmFrames(adjustedPrimary, adjustedEffect)
        : adjustedPrimary;
      const opusFrame = this.encoder.encode(adjusted);
      const diagnostics = this.getPlaybackDiagnostics();
      this.emit("frame", opusFrame, {
        mode: this.playbackMode,
        voiced:
          this.playbackMode === "realtime" &&
          primaryFrame !== null &&
          isPcmFrameVoiced(adjustedPrimary),
        diagnostics,
      } satisfies PlayerFrameMetadata);
      if (primaryFrame || (this.externalMode && this.state === "playing")) {
        this.framesPlayed++;
      }
      if (primaryFrame) {
        this.healthyFrames++;
        if (this.healthyFrames >= AudioPlayer.HEALTHY_FRAME_RESET) {
          this.consecutiveFailures = 0;
          this.healthyFrames = 0;
        }
      }
    } catch (err) {
      this.emit("error", err as Error);
    }
  }

  private observeRealtimePcm(chunk: Buffer): void {
    const combined = Buffer.concat([this.realtimeIngressCarry, chunk]);
    const receivedAt = Date.now();
    let offset = 0;
    while (offset + PCM_FRAME_BYTES <= combined.length) {
      const frame = combined.subarray(offset, PCM_FRAME_BYTES);
      const update = updateRealtimePcmIngressTelemetry(this.realtimeIngress, {
        voiced: isPcmFrameVoiced(frame),
        receivedAt,
      });
      this.realtimeIngress = update.state;
      if (update.speechStarted) {
        this.logger.info({
          decodedAt: receivedAt,
          bufferedMs: pcmBytesToMs(this.pcmBuffer.length),
        }, "Realtime decoder first voiced PCM received");
      }
      offset += PCM_FRAME_BYTES;
    }
    this.realtimeIngressCarry = Buffer.from(combined.subarray(offset));
  }

  private emitSilenceFrame(): void {
    try {
      const opusFrame = this.encoder.encode(Buffer.alloc(PCM_FRAME_BYTES));
      this.emit("frame", opusFrame, {
        mode: this.playbackMode,
        voiced: false,
        diagnostics: this.getPlaybackDiagnostics(),
      } satisfies PlayerFrameMetadata);
      this.framesPlayed++;
    } catch (err) {
      this.emit("error", err as Error);
    }
  }

  private applyVolume(pcm: Buffer, now = performance.now()): Buffer {
    const baseFactor = volumeToFactor(this.volume);
    const startDuckingGain = this.duckingGainAt(now);
    const endDuckingGain = this.duckingGainAt(now + FRAME_DURATION_MS);
    const startFactor = baseFactor * startDuckingGain;
    const endFactor = baseFactor * endDuckingGain;

    if (startFactor >= 1 && endFactor >= 1) {
      return Buffer.from(pcm);
    }

    const out = Buffer.alloc(pcm.length);
    // Most frames are outside the short attack/release windows. Preserve the
    // old constant-factor hot path instead of doing interpolation per sample.
    if (startFactor === endFactor) {
      for (let i = 0; i < pcm.length; i += 2) {
        const sample = Math.round(pcm.readInt16LE(i) * startFactor);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
      }
      return out;
    }

    // PCM is fixed at stereo s16le. Use one gain for each L/R pair so a ramp
    // never creates a tiny channel imbalance, and span the whole 20 ms frame.
    const stereoFrames = Math.max(1, Math.ceil(pcm.length / 4));
    for (let i = 0; i < pcm.length; i += 2) {
      const frameIndex = Math.floor(i / 4);
      const progress = stereoFrames === 1 ? 0 : frameIndex / (stereoFrames - 1);
      const factor = startFactor + (endFactor - startFactor) * progress;
      const sample = Math.round(pcm.readInt16LE(i) * factor);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
    }
    return out;
  }

  private duckingGainAt(at: number): number {
    if (this.duckingRampDurationMs <= 0) return this.duckingTargetGain;

    const progress = Math.max(
      0,
      Math.min(1, (at - this.duckingRampStartedAt) / this.duckingRampDurationMs),
    );
    return (
      this.duckingRampStartGain +
      (this.duckingTargetGain - this.duckingRampStartGain) * progress
    );
  }

  // NOTE: in external (Spotify sidecar) mode getElapsed() is frame-count based
  // (framesPlayed includes silence frames emitted on underrun) and therefore
  // only APPROXIMATE — the authoritative position is the controller's live
  // status.track.position. This approximation is acceptable for Spotify.
  getElapsed(): number { return this.seekOffset + (this.framesPlayed * FRAME_DURATION_MS) / 1000; }
  getPlaybackDiagnostics(): PlaybackDiagnostics {
    return buildPlaybackDiagnostics(
      this.playbackMode,
      this.pcmBuffer.length,
      this.realtimeDroppedBytes,
      this.ffmpegPaused,
      this.realtimeIngress,
    );
  }
  seek(seconds: number): void {
    // External (Spotify sidecar) mode: local seek is a no-op. Respawning ffmpeg
    // on the spotify: sentinel would collide with the continuous PCM source;
    // transport is delegated to the SpotifyController by the caller (Task 7).
    if (this.externalMode) return;
    if (this.currentUrl && Number.isFinite(seconds) && seconds >= 0) {
      this.play(this.currentUrl, seconds, this.currentSongDuration);
    }
  }
  pause(): void { if (this.state === "playing") this.state = "paused"; }
  resume(): void { if (this.state === "paused") { this.state = "playing"; this.nextFrameTime = performance.now(); } }
  resetFailures(): void { this.consecutiveFailures = 0; }
  setVolume(vol: number): void { this.volume = Math.max(0, Math.min(100, vol)); }
  getVolume(): number { return this.volume; }
  /** Set the temporary voice-ducking gain (0=silent, 1=unchanged). */
  setDuckingGain(gain: number, rampMs = 0): void {
    if (!Number.isFinite(gain)) return;

    const now = performance.now();
    const currentGain = this.duckingGainAt(now);
    const targetGain = Math.max(0, Math.min(1, gain));
    const duration = Number.isFinite(rampMs) ? Math.max(0, rampMs) : 0;

    this.duckingRampStartGain = currentGain;
    this.duckingTargetGain = targetGain;
    this.duckingRampStartedAt = now;
    this.duckingRampDurationMs =
      duration > 0 && currentGain !== targetGain ? duration : 0;
  }
  getDuckingGain(): number { return this.duckingGainAt(performance.now()); }
  getState(): PlayerState { return this.state; }
  /** Changes on stop or a new play/seek, so asynchronous recovery can be fenced. */
  getPlaybackSessionId(): number { return this.sessionId; }
  // True only while attached to an external (Spotify sidecar) PCM stream. Used
  // by the orchestrator to decide whether to re-attach: stop() detaches (sets
  // externalMode=false) so this is false after any player.stop().
  isExternalActive(): boolean { return this.externalMode; }
}
