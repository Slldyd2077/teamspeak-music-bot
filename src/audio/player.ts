import { spawn, execSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { accessSync, chmodSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpusEncoder, PCM_FRAME_BYTES, type Encoder } from "./encoder.js";
import type { Logger } from "../logger.js";

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

function getFfmpegCommand(): string {
  return resolvedFfmpeg;
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

export function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export function buildFfmpegArgs(url: string, seekSeconds: number): string[] {
  const args: string[] = [];
  const isHttp = /^https?:\/\//i.test(url);

  if (isHttp && (url.includes("bilivideo") || url.includes("bilibili"))) {
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
  if (seekSeconds > 0) args.push("-ss", String(seekSeconds));
  args.push("-i", url, "-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "-");

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

export interface PlayerEvents {
  frame: (opusFrame: Buffer) => void;
  trackEnd: () => void;
  error: (err: Error) => void;
}

export type PlayerState = "idle" | "playing" | "paused";

const FRAME_DURATION_MS = 20;

export class AudioPlayer extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private encoder: Encoder;
  private state: PlayerState = "idle";
  private volume = 75;
  private pcmBuffer: Buffer = Buffer.alloc(0);
  private logger: Logger;
  private frameLoopRunning = false;
  private nextFrameTime = 0;
  private currentUrl = "";
  private seekOffset = 0;
  private framesPlayed = 0;
  private sessionId = 0;
  private static readonly BUFFER_HIGH_WATER = 640 * 1024;
  private static readonly BUFFER_LOW_WATER = 256 * 1024;
  private ffmpegPaused = false;
  private spawnFailed = false;
  private consecutiveFailures = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;
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

  constructor(logger: Logger) {
    super();
    this.encoder = createOpusEncoder();
    this.logger = logger;
  }

  play(url: string, seekSeconds = 0, songDuration = 0): void {
    // 1. 停止当前所有播放，自增 sessionId 屏蔽旧回调 （
    this.stop();

    const currentSessionId = this.sessionId; 
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

    const args = buildFfmpegArgs(url, seekSeconds);

    const ffmpegBin = getFfmpegCommand();
    this.ffmpeg = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    
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
      
      this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);
      if (this.pcmBuffer.length > AudioPlayer.BUFFER_HIGH_WATER && !this.ffmpegPaused && this.ffmpeg?.stdout) {
        this.ffmpeg.stdout.pause();
        this.ffmpegPaused = true;
      }
    });

    this.ffmpeg.on("exit", (code, signal) => {
      if (currentPid) globalActivePids.delete(currentPid);
      this.logger.info({ pid: currentPid, code, signal }, "FFmpeg exited");
      
      // 只有当前会话的进程结束才置空变量
      if (this.sessionId === currentSessionId) {
        this.ffmpeg = null;
      }
    });

    this.ffmpeg.on("error", (err) => {
      if (this.sessionId === currentSessionId) {
        this.spawnFailed = true;
        this.consecutiveFailures++;
        this.emit("error", err);
      }
    });

    this.state = "playing";
    this.startFrameLoop();
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
      "powershell",
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

    let stderrTail = "";
    ps.stderr!.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-500);
    });

    ps.on("exit", (code, signal) => {
      if (this.sessionId !== sessionId) {
        cleanupTempDir(tempDir);
        return;
      }
      this.downloader = null;
      if (code !== 0) {
        this.logger.warn({ code, signal, stderr: stderrTail }, "PowerShell download failed");
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

    const currentPid = this.ffmpeg.pid;
    if (currentPid) {
      globalActivePids.add(currentPid);
      this.logger.debug({ pid: currentPid, sessionId }, "FFmpeg spawned (from temp file)");
    }
    const tempDirToCleanup = this.currentTempDir;

    this.ffmpeg.stdout!.on("data", (chunk: Buffer) => {
      if (this.sessionId !== sessionId) return;
      this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);
      if (this.pcmBuffer.length > AudioPlayer.BUFFER_HIGH_WATER && !this.ffmpegPaused && this.ffmpeg?.stdout) {
        this.ffmpeg.stdout.pause();
        this.ffmpegPaused = true;
      }
    });

    this.ffmpeg.on("exit", (code, signal) => {
      if (currentPid) globalActivePids.delete(currentPid);
      this.logger.info({ pid: currentPid, code, signal }, "FFmpeg exited");
      if (this.sessionId === sessionId) {
        this.ffmpeg = null;
        if (this.currentTempDir === tempDirToCleanup) this.currentTempDir = null;
      }
      if (tempDirToCleanup) cleanupTempDir(tempDirToCleanup);
    });

    this.ffmpeg.on("error", (err) => {
      if (this.sessionId === sessionId) {
        this.spawnFailed = true;
        this.consecutiveFailures++;
        this.emit("error", err);
      }
    });

    // Now that ffmpeg is producing PCM, run the frame loop.
    this.startFrameLoop();
  }

  stop(): void {
    // 3. 递增 ID 是最有效的逻辑“隔离墙”
    this.sessionId++; 
    this.frameLoopRunning = false;
    
    // 立即清空缓冲区，确保切歌瞬间静音 （
    this.pcmBuffer = Buffer.alloc(0);

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
      try { ps.kill("SIGTERM"); } catch { /* already gone */ }
    }

    if (this.currentTempDir) {
      cleanupTempDir(this.currentTempDir);
      this.currentTempDir = null;
    }

    this.ffmpegPaused = false;
    this.spawnFailed = false;
    this.state = "idle";
    this.currentUrl = "";
    this.seekOffset = 0;
    this.framesPlayed = 0;
    this.healthyFrames = 0;
  }

  private forceCleanup(proc: ChildProcess, pid: number): void {
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

      if (this.state === "playing") this.sendNextFrame();
      else if (this.state === "paused") this.nextFrameTime = performance.now();

      // 检测pcmBuffer不足PCM_FRAME_BYTES导致连续循环卡死：
      // 条件1: FFmpeg仍在运行但缓冲区不足一帧，且连续多次无法获取数据
      // 条件2: 已播放时间接近歌曲结尾（最后5秒内）或未知时长
      const elapsed = this.getElapsed();
      const isNearEnd = this.currentSongDuration > 0 
        ? (this.currentSongDuration - elapsed) <= 5 // 距离结尾不足5秒
        : true; // 未知时长时保守处理
      
      if (this.ffmpeg !== null && this.pcmBuffer.length < PCM_FRAME_BYTES) {
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
          }, "FFmpeg stopped outputting data, ending track");
          this.frameLoopRunning = false;
          if (this.state !== "idle") {
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
          }
          return;
        }
      } else {
        // 成功获取数据或FFmpeg已结束，重置计数器
        this.emptyFrameAttempts = 0;
      }

      if (!this.ffmpeg && this.pcmBuffer.length < PCM_FRAME_BYTES) {
        this.frameLoopRunning = false;
        if (this.state !== "idle") {
          this.state = "idle";
          if (!this.spawnFailed) {
            this.consecutiveFailures = 0;
            this.emit("trackEnd");
          }
        }
        return;
      }
      this.scheduleNextFrame();
    }, delay);
  }

  private sendNextFrame(): void {
    if (this.pcmBuffer.length < PCM_FRAME_BYTES) return;
    const pcmFrame = this.pcmBuffer.subarray(0, PCM_FRAME_BYTES);
    this.pcmBuffer = this.pcmBuffer.subarray(PCM_FRAME_BYTES);

    if (this.ffmpegPaused && this.pcmBuffer.length < AudioPlayer.BUFFER_LOW_WATER && this.ffmpeg?.stdout) {
      this.ffmpeg.stdout.resume();
      this.ffmpegPaused = false;
    }

    try {
      const adjusted = this.applyVolume(pcmFrame);
      const opusFrame = this.encoder.encode(adjusted);
      this.emit("frame", opusFrame);
      this.framesPlayed++;
      this.healthyFrames++;
      if (this.healthyFrames >= AudioPlayer.HEALTHY_FRAME_RESET) {
        this.consecutiveFailures = 0;
        this.healthyFrames = 0;
      }
    } catch (err) {
      this.emit("error", err as Error);
    }
  }

  private applyVolume(pcm: Buffer): Buffer {
    if (this.volume === 100) return Buffer.from(pcm);
    const factor = (this.volume / 100) * 0.2;
    const out = Buffer.alloc(pcm.length);
    for (let i = 0; i < pcm.length; i += 2) {
      let sample = Math.round(pcm.readInt16LE(i) * factor);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
    }
    return out;
  }

  getElapsed(): number { return this.seekOffset + (this.framesPlayed * FRAME_DURATION_MS) / 1000; }
  seek(seconds: number): void { 
    if (this.currentUrl && Number.isFinite(seconds) && seconds >= 0) {
      this.play(this.currentUrl, seconds, this.currentSongDuration);
    }
  }
  pause(): void { if (this.state === "playing") this.state = "paused"; }
  resume(): void { if (this.state === "paused") { this.state = "playing"; this.nextFrameTime = performance.now(); } }
  resetFailures(): void { this.consecutiveFailures = 0; }
  setVolume(vol: number): void { this.volume = Math.max(0, Math.min(100, vol)); }
  getVolume(): number { return this.volume; }
  getState(): PlayerState { return this.state; }
}