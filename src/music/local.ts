import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import crypto from "node:crypto";
import type {
  Album,
  AuthStatus,
  LyricLine,
  MusicProvider,
  Playlist,
  PlaylistDetail,
  QrCodeResult,
  SearchResult,
  Song,
  SongUrlResult,
} from "./provider.js";

const require = createRequire(import.meta.url);
const ffmpegPath: string | null = require("ffmpeg-static");

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".flac",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".webm",
  ".wma",
  ".alac",
  ".aiff",
  ".ape",
]);

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

export interface LocalMusicProviderOptions {
  /** Max number of uploaded files kept on disk (oldest unreferenced evicted). */
  maxFiles?: number;
  /** Max total bytes of uploaded files kept on disk. */
  maxTotalBytes?: number;
}

interface LocalSongRecord extends Song {
  filePath: string;
  originalName: string;
  uploadedAt: string;
  size: number;
  mimeType: string;
}

function safeFileName(name: string): string {
  const base = path.basename(name || "audio")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return "audio";
  // Cap the total length but ALWAYS preserve the extension — truncating the
  // whole string would drop a trailing ".mp3" on a long filename and make the
  // file fail extension validation.
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  const safeStem = stem.slice(0, Math.max(1, 160 - ext.length)) || "audio";
  return `${safeStem}${ext}`;
}

function titleFromFileName(name: string): string {
  return safeFileName(name).replace(/\.[^.]+$/, "") || "本地音频";
}

async function probeDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegPath || "ffmpeg", ["-hide_banner", "-i", filePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      resolve(0);
    }, 5000);
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    ffmpeg.on("error", () => {
      clearTimeout(timeout);
      resolve(0);
    });
    ffmpeg.on("close", () => {
      clearTimeout(timeout);
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) {
        resolve(0);
        return;
      }
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      const total = hours * 3600 + minutes * 60 + seconds;
      resolve(Number.isFinite(total) ? Math.round(total) : 0);
    });
  });
}

export class LocalMusicProvider implements MusicProvider {
  readonly platform = "local" as const;
  private readonly uploadDir: string;
  private readonly indexPath: string;
  private records: LocalSongRecord[] = [];
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  /** Ids that have been resolved for playback at least once; only these are
   *  eligible for reference-aware cleanup, so freshly uploaded files that are
   *  not yet queued/played survive in the search list. */
  private playedIds = new Set<string>();
  /** Returns the set of local song ids still referenced by any bot's queue.
   *  Deletion never removes a file whose id this set contains. */
  private inUseResolver: () => Set<string> = () => new Set<string>();
  /** Ids with an in-flight retry-delete scheduled (file briefly locked, e.g.
   *  ffmpeg on Windows still releasing a just-stopped track). */
  private retrying = new Set<string>();

  constructor(uploadDir: string, options: LocalMusicProviderOptions = {}) {
    this.uploadDir = uploadDir;
    this.indexPath = path.join(uploadDir, "index.json");
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    mkdirSync(uploadDir, { recursive: true });
    this.loadIndex();
  }

  /** Wire the resolver the BotManager uses to report which uploads are still
   *  queued anywhere. Must be set before any cleanup can delete files. */
  setInUseResolver(resolver: () => Set<string>): void {
    this.inUseResolver = resolver;
  }

  private referencedIds(): Set<string> | null {
    try {
      return this.inUseResolver() ?? new Set<string>();
    } catch {
      // Resolver failure → references unknown → refuse to delete anything.
      return null;
    }
  }

  private loadIndex(): void {
    try {
      const raw = readFileSync(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as LocalSongRecord[];
      this.records = Array.isArray(parsed)
        ? parsed.filter((r) => r && typeof r.id === "string" && typeof r.filePath === "string")
        : [];
    } catch {
      this.records = [];
    }
  }

  private saveIndex(): void {
    writeFileSync(this.indexPath, JSON.stringify(this.records, null, 2), "utf8");
  }

  async uploadAudio(input: {
    buffer: Buffer;
    originalName: string;
    mimeType?: string;
  }): Promise<Song> {
    const originalName = safeFileName(input.originalName || "audio");
    const ext = path.extname(originalName).toLowerCase();
    // Validate by the (sanitised) file extension only — never trust the
    // client-supplied Content-Type. This also guarantees the STORED extension
    // is one of the known audio types, so a spoofed header cannot persist an
    // arbitrary-extension blob on disk.
    if (!AUDIO_EXTENSIONS.has(ext)) {
      throw new Error("只支持常见音频文件，如 mp3、flac、wav、m4a、ogg、opus、aac、webm 等");
    }
    if (!input.buffer || input.buffer.length === 0) {
      throw new Error("上传文件为空");
    }

    const id = crypto.randomUUID();
    const storedName = `${id}${ext}`;
    const filePath = path.join(this.uploadDir, storedName);
    writeFileSync(filePath, input.buffer);

    const duration = await probeDurationSeconds(filePath);
    const song: LocalSongRecord = {
      id,
      name: titleFromFileName(originalName),
      artist: "本地上传",
      album: "本地音乐",
      duration,
      coverUrl: "",
      platform: "local",
      filePath,
      originalName,
      uploadedAt: new Date().toISOString(),
      size: input.buffer.length,
      mimeType: input.mimeType || "application/octet-stream",
    };

    this.records.unshift(song);
    this.saveIndex();
    // Never evict the file we just accepted, even if every older file is still
    // queued — returning success for a file we deleted would be a phantom entry.
    this.enforceQuota(id);
    return this.toSong(song);
  }

  private toSong(record: LocalSongRecord): Song {
    const { filePath: _filePath, originalName: _originalName, uploadedAt: _uploadedAt, size: _size, mimeType: _mimeType, ...song } = record;
    return song;
  }

  async search(query: string, limit = 20): Promise<SearchResult> {
    const q = query.trim().toLowerCase();
    const songs = this.records
      .filter((r) => existsSync(r.filePath))
      .filter((r) => !q || `${r.name} ${r.artist} ${r.album} ${r.originalName}`.toLowerCase().includes(q))
      .slice(0, limit)
      .map((r) => this.toSong(r));
    return { songs, playlists: [], albums: [] };
  }

  async getSongUrl(songId: string): Promise<SongUrlResult | null> {
    const record = this.records.find((r) => r.id === songId);
    if (!record || !existsSync(record.filePath)) return null;
    // A song that is actually resolved for playback becomes eligible for
    // cleanup once it is no longer referenced by any queue.
    this.playedIds.add(songId);
    return { url: record.filePath };
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    const record = this.records.find((r) => r.id === songId);
    return record && existsSync(record.filePath) ? this.toSong(record) : null;
  }

  /**
   * Reference-aware cleanup: delete only files that have been played at least
   * once AND are no longer referenced by any bot's queue. Safe to call after
   * any queue mutation — a file still queued anywhere (loop replay, prev,
   * the song being re-started, the same upload queued on another bot) is kept.
   * Returns the ids that were deleted.
   */
  sweepUnreferenced(): string[] {
    const inUse = this.referencedIds();
    if (!inUse) return [];
    const deleted: string[] = [];
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (!this.playedIds.has(r.id) || inUse.has(r.id)) continue;
      if (this.unlinkRecordAt(i)) {
        deleted.push(r.id);
      } else {
        // File still locked (e.g. ffmpeg just-stopped on Windows) — keep the
        // record and retry shortly; never orphan it or abort the rest.
        this.scheduleRetry(r.id);
      }
    }
    if (deleted.length) this.saveIndex();
    return deleted;
  }

  /** Evict oldest, never-referenced uploads until under the file-count and
   *  total-byte caps. Bounds disk use from uploads that are never played.
   *  `protectId` is never evicted (the file just uploaded in this same call). */
  private enforceQuota(protectId?: string): void {
    if (this.records.length <= this.maxFiles &&
        this.totalBytes() <= this.maxTotalBytes) {
      return;
    }
    const inUse = this.referencedIds();
    if (!inUse) return; // can't safely evict without knowing references
    let count = this.records.length;
    let bytes = this.totalBytes();
    let changed = false;
    for (let i = this.records.length - 1;
         i >= 0 && (count > this.maxFiles || bytes > this.maxTotalBytes);
         i--) {
      const r = this.records[i];
      if (inUse.has(r.id) || r.id === protectId) continue; // never evict these
      const size = r.size || 0;
      if (this.unlinkRecordAt(i)) {
        count--;
        bytes -= size;
        changed = true;
      }
    }
    if (changed) this.saveIndex();
  }

  /**
   * Delete the backing file for records[index] and drop the record from memory.
   * Deletes the FILE FIRST, then mutates state only on success, so a failed
   * unlink leaves the record intact (file + index stay consistent) instead of
   * orphaning the file. Returns true if the file is gone (deleted or already
   * absent), false if it is still present (locked). Never throws; does NOT
   * persist the index — callers batch saveIndex().
   */
  private unlinkRecordAt(index: number): boolean {
    const r = this.records[index];
    try {
      rmSync(r.filePath, { force: true });
    } catch {
      // rmSync force:true only swallows ENOENT; EBUSY/EPERM/EACCES throw. If
      // the file genuinely vanished anyway, fall through and drop the record.
      if (existsSync(r.filePath)) return false;
    }
    this.records.splice(index, 1);
    this.playedIds.delete(r.id);
    this.retrying.delete(r.id);
    return true;
  }

  /** Schedule a bounded, non-blocking retry to delete a briefly-locked file.
   *  Uses unref'd timers so it never keeps the process alive. */
  private scheduleRetry(id: string, attempt = 1): void {
    if (attempt === 1 && this.retrying.has(id)) return;
    this.retrying.add(id);
    const MAX_ATTEMPTS = 6;
    const timer = setTimeout(() => {
      const index = this.records.findIndex((r) => r.id === id);
      if (index < 0) { this.retrying.delete(id); return; } // already removed
      const inUse = this.referencedIds();
      if (!inUse || inUse.has(id)) { this.retrying.delete(id); return; } // unknown or re-queued
      if (this.unlinkRecordAt(index)) {
        this.saveIndex();
      } else if (attempt < MAX_ATTEMPTS) {
        this.scheduleRetry(id, attempt + 1);
      } else {
        this.retrying.delete(id); // give up; next sweep/quota will retry
      }
    }, 500 * attempt);
    if (typeof timer.unref === "function") timer.unref();
  }

  private totalBytes(): number {
    return this.records.reduce((n, r) => n + (r.size || 0), 0);
  }

  setQuality(_quality: string): void {
    // 本地文件按原始音质播放。
  }

  getQuality(): string {
    return "original";
  }

  async getPlaylistSongs(_playlistId: string): Promise<Song[]> {
    return [];
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    return [];
  }

  async getAlbumSongs(_albumId: string): Promise<Song[]> {
    return [];
  }

  async getLyrics(_songId: string): Promise<LyricLine[]> {
    return [];
  }

  async getQrCode(): Promise<QrCodeResult> {
    throw new Error("Local music does not require login");
  }

  async checkQrCodeStatus(_key: string): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    return "expired";
  }

  setCookie(_cookie: string): void {
    // no-op
  }

  getCookie(): string {
    return "";
  }

  async getAuthStatus(): Promise<AuthStatus> {
    return { loggedIn: true, nickname: "本地音乐" };
  }

  async getPlaylistDetail(_playlistId: string): Promise<PlaylistDetail | null> {
    return null;
  }
}
