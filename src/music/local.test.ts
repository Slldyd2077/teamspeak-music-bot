import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMusicProvider } from "./local.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "local-audio-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Seed real files + an index.json so we can exercise the cleanup lifecycle
// without invoking the ffmpeg duration probe that uploadAudio runs.
function makeRecord(id: string, bytes = 16) {
  const filePath = join(dir, `${id}.mp3`);
  writeFileSync(filePath, Buffer.alloc(bytes, 1));
  return {
    id,
    name: id,
    artist: "本地上传",
    album: "本地音乐",
    duration: 0,
    coverUrl: "",
    platform: "local" as const,
    filePath,
    originalName: `${id}.mp3`,
    uploadedAt: "1970-01-01T00:00:00.000Z",
    size: bytes,
    mimeType: "audio/mpeg",
  };
}

function seed(records: ReturnType<typeof makeRecord>[]) {
  writeFileSync(join(dir, "index.json"), JSON.stringify(records), "utf8");
}

describe("LocalMusicProvider cleanup lifecycle", () => {
  it("sweep keeps referenced and never-played files, deletes only played+unreferenced", async () => {
    const a = makeRecord("a");
    const b = makeRecord("b");
    const c = makeRecord("c");
    seed([a, b, c]);
    const p = new LocalMusicProvider(dir);
    const refs = new Set<string>(["a"]); // "a" still sits in a queue somewhere
    p.setInUseResolver(() => refs);

    await p.getSongUrl("a"); // played, but referenced
    await p.getSongUrl("b"); // played and unreferenced
    // "c" was never played (e.g. uploaded but not queued)

    const deleted = p.sweepUnreferenced();

    expect(deleted).toEqual(["b"]);
    expect(existsSync(a.filePath)).toBe(true); // referenced → kept
    expect(existsSync(b.filePath)).toBe(false); // played + unreferenced → deleted
    expect(existsSync(c.filePath)).toBe(true); // never played → kept
  });

  it("a played song still in the queue survives the sweep and stays replayable (loop / prev)", async () => {
    const a = makeRecord("a");
    seed([a]);
    const p = new LocalMusicProvider(dir);
    const refs = new Set<string>(["a"]); // loop queue still references it
    p.setInUseResolver(() => refs);

    await p.getSongUrl("a"); // first pass plays it
    p.sweepUnreferenced(); // "playback_finished" sweep

    expect(existsSync(a.filePath)).toBe(true);
    expect((await p.getSongUrl("a"))?.url).toBe(a.filePath); // next loop pass works
  });

  it("re-playing a queued local song does not delete it (play-song order)", async () => {
    const a = makeRecord("a");
    seed([a]);
    const p = new LocalMusicProvider(dir);
    // Mirror the fixed endpoint order: the song is (re)added to the queue
    // BEFORE the sweep runs, so it is referenced when we sweep.
    const refs = new Set<string>(["a"]);
    p.setInUseResolver(() => refs);

    await p.getSongUrl("a"); // played once
    p.sweepUnreferenced(); // sweep fired after the replay re-queued it
    expect(existsSync(a.filePath)).toBe(true);
    expect(await p.getSongUrl("a")).not.toBeNull();
  });

  it("deletes a played file once it leaves every queue", async () => {
    const a = makeRecord("a");
    seed([a]);
    const p = new LocalMusicProvider(dir);
    let refs = new Set<string>(["a"]);
    p.setInUseResolver(() => refs);

    await p.getSongUrl("a");
    p.sweepUnreferenced();
    expect(existsSync(a.filePath)).toBe(true); // still queued

    refs = new Set<string>(); // queue cleared
    p.sweepUnreferenced();
    expect(existsSync(a.filePath)).toBe(false); // now removed
    expect(await p.getSongUrl("a")).toBeNull();
  });

  it("never deletes anything when the reference resolver throws", async () => {
    const a = makeRecord("a");
    seed([a]);
    const p = new LocalMusicProvider(dir);
    p.setInUseResolver(() => {
      throw new Error("manager unavailable");
    });
    await p.getSongUrl("a");
    expect(p.sweepUnreferenced()).toEqual([]);
    expect(existsSync(a.filePath)).toBe(true);
  });
});

describe("LocalMusicProvider upload validation", () => {
  it("rejects a spoofed Content-Type with a non-audio extension", async () => {
    const p = new LocalMusicProvider(dir);
    await expect(
      p.uploadAudio({
        buffer: Buffer.from("malicious"),
        originalName: "evil.exe",
        mimeType: "application/octet-stream",
      }),
    ).rejects.toThrow();
  });

  it("rejects an unknown extension even when the mime claims audio", async () => {
    const p = new LocalMusicProvider(dir);
    await expect(
      p.uploadAudio({
        buffer: Buffer.from("x"),
        originalName: "evil.html",
        mimeType: "audio/mpeg",
      }),
    ).rejects.toThrow();
  });

  it("rejects an empty file", async () => {
    const p = new LocalMusicProvider(dir);
    await expect(
      p.uploadAudio({ buffer: Buffer.alloc(0), originalName: "a.mp3" }),
    ).rejects.toThrow();
  });
});

describe("LocalMusicProvider quota", () => {
  it("evicts oldest unreferenced uploads beyond maxFiles", async () => {
    const a = makeRecord("a");
    const b = makeRecord("b");
    seed([b, a]); // newest-first: b newer than a
    const p = new LocalMusicProvider(dir, { maxFiles: 2 });
    p.setInUseResolver(() => new Set<string>());

    // Upload a third valid file → over the 2-file cap → evict the oldest ("a").
    await p.uploadAudio({
      buffer: Buffer.alloc(16, 7),
      originalName: "c.mp3",
      mimeType: "audio/mpeg",
    });

    expect(existsSync(a.filePath)).toBe(false); // oldest evicted
    expect(existsSync(b.filePath)).toBe(true);
    const result = await p.search("");
    expect(result.songs.map((s) => s.id).sort()).not.toContain("a");
  });

  it("does not evict a referenced upload even when over the cap", async () => {
    const a = makeRecord("a");
    const b = makeRecord("b");
    seed([b, a]);
    const p = new LocalMusicProvider(dir, { maxFiles: 1 });
    p.setInUseResolver(() => new Set<string>(["a"])); // "a" is queued

    await p.uploadAudio({
      buffer: Buffer.alloc(16, 7),
      originalName: "c.mp3",
      mimeType: "audio/mpeg",
    });

    expect(existsSync(a.filePath)).toBe(true); // protected: still queued
  });

  it("never evicts the just-uploaded file, even when every older file is referenced", async () => {
    const a = makeRecord("a");
    seed([a]);
    const p = new LocalMusicProvider(dir, { maxFiles: 1 });
    p.setInUseResolver(() => new Set<string>(["a"])); // the only older file is queued

    const song = await p.uploadAudio({
      buffer: Buffer.alloc(16, 7),
      originalName: "c.mp3",
      mimeType: "audio/mpeg",
    });

    // The returned song must actually exist and be playable — not a phantom.
    expect(await p.getSongUrl(song.id)).not.toBeNull();
  });
});

describe("LocalMusicProvider filename handling", () => {
  it("accepts a long filename without dropping its extension", async () => {
    const p = new LocalMusicProvider(dir);
    const longName = "x".repeat(300) + ".mp3";
    // Must not throw the "unsupported format" error — the extension survives.
    const song = await p.uploadAudio({
      buffer: Buffer.alloc(16, 1),
      originalName: longName,
      mimeType: "audio/mpeg",
    });
    expect(song.id).toBeTruthy();
    expect(await p.getSongUrl(song.id)).not.toBeNull();
  });
});
