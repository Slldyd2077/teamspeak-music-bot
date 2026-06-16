import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFfmpegArgs, shouldUsePowerShellDownload, cleanupTempDir, shouldEndOnStall, volumeToFactor } from "./player.js";

function getHeadersArg(args: string[]): string {
  const idx = args.indexOf("-headers");
  if (idx === -1) return "";
  return args[idx + 1] ?? "";
}

describe("buildFfmpegArgs", () => {
  it("includes browser User-Agent and Referer for Netease CDN URLs", () => {
    const url = "http://m701.music.126.net/some/path/song.mp3?vuutv=abc";
    const args = buildFfmpegArgs(url, 0);
    const headers = getHeadersArg(args);
    expect(headers).toContain("User-Agent:");
    expect(headers).toContain("Mozilla/5.0");
    expect(headers).toContain("Referer: https://music.163.com/");
  });

  it("keeps Bilibili Referer + UA for bilibili URLs", () => {
    const url = "https://upos-sz-mirrorcoso1.bilivideo.com/foo/bar.mp3";
    const args = buildFfmpegArgs(url, 0);
    const headers = getHeadersArg(args);
    expect(headers).toContain("Referer: https://www.bilibili.com");
    expect(headers).toContain("User-Agent: Mozilla/5.0");
  });

  it("does not set custom headers for unknown URLs", () => {
    const url = "https://example.com/song.mp3";
    const args = buildFfmpegArgs(url, 0);
    expect(args).not.toContain("-headers");
  });

  it("includes resilient reconnect flags for all URLs", () => {
    const args = buildFfmpegArgs("https://example.com/song.mp3", 0);
    expect(args).toContain("-reconnect");
    expect(args).toContain("-reconnect_streamed");
    expect(args).toContain("-reconnect_delay_max");
    expect(args).toContain("-reconnect_on_network_error");
    expect(args).toContain("-reconnect_on_http_error");
    const idx = args.indexOf("-reconnect_delay_max");
    expect(Number(args[idx + 1])).toBeGreaterThanOrEqual(30);
  });

  it("sets -reconnect_at_eof 1 (before -i) so long B站 streams resume after premature EOF (#89)", () => {
    const args = buildFfmpegArgs("https://x.bilivideo.com/audio.m4s", 0);
    const idx = args.indexOf("-reconnect_at_eof");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("1");
    expect(idx).toBeLessThan(args.indexOf("-i")); // input options must precede -i
  });

  it("inserts -ss before -i when seekSeconds > 0", () => {
    const args = buildFfmpegArgs("https://example.com/song.mp3", 42);
    const ssIdx = args.indexOf("-ss");
    const iIdx = args.indexOf("-i");
    expect(ssIdx).toBeGreaterThan(-1);
    expect(args[ssIdx + 1]).toBe("42");
    expect(ssIdx).toBeLessThan(iIdx);
  });

  it("does not insert -ss when seekSeconds is 0", () => {
    const args = buildFfmpegArgs("https://example.com/song.mp3", 0);
    expect(args).not.toContain("-ss");
  });

  it("omits HTTP-only flags when input is a local file path", () => {
    const args = buildFfmpegArgs("C:/temp/song.mp3", 0);
    expect(args).not.toContain("-reconnect");
    expect(args).not.toContain("-reconnect_at_eof");
    expect(args).not.toContain("-reconnect_on_network_error");
    expect(args).not.toContain("-reconnect_on_http_error");
    expect(args).not.toContain("-headers");
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe("C:/temp/song.mp3");
  });

  it("ends args with the input URL and PCM output spec", () => {
    const url = "https://example.com/song.mp3";
    const args = buildFfmpegArgs(url, 0);
    const iIdx = args.indexOf("-i");
    expect(args[iIdx + 1]).toBe(url);
    expect(args).toContain("-f");
    expect(args).toContain("s16le");
    expect(args[args.length - 1]).toBe("-");
  });
});

describe("volumeToFactor (#84 smooth volume curve)", () => {
  it("is 0 at vol 0 and exactly 1.0 at vol 100 (full loudness still reserved at 100)", () => {
    expect(volumeToFactor(0)).toBe(0);
    expect(volumeToFactor(100)).toBe(1);
  });

  it("clamps out-of-range input", () => {
    expect(volumeToFactor(-20)).toBe(0);
    expect(volumeToFactor(150)).toBe(1);
  });

  it("is strictly monotonic across the whole range (no dead zone)", () => {
    for (let v = 0; v < 100; v++) {
      expect(volumeToFactor(v + 1)).toBeGreaterThan(volumeToFactor(v));
    }
  });

  it("removes the old flat 80-99 dead zone", () => {
    // Old mapping moved only 0.16 -> 0.198 across 80..99; new curve climbs clearly.
    expect(volumeToFactor(99) - volumeToFactor(80)).toBeGreaterThan(0.3);
  });

  it("removes the discontinuity at 100 (old jump was ~0.8)", () => {
    expect(volumeToFactor(100) - volumeToFactor(99)).toBeLessThan(0.1);
  });

  it("keeps the low range gentle", () => {
    expect(volumeToFactor(50)).toBeLessThan(0.12);
  });
});

describe("shouldUsePowerShellDownload", () => {
  const jdymusicUrl =
    "http://m801.music.126.net/20260507/abc/jdymusic/obj/xyz/song.mp3?vuutv=tok";
  const newCdnUrl =
    "http://m801.music.126.net/20260507/abc/jd-musicrep-ts/obj/xyz/song.mp3?vuutv=tok";
  const ymusicUrl =
    "http://m801.music.126.net/20260507/abc/ymusic/obj/xyz/song.mp3?vuutv=tok";

  it("returns true for /jdymusic/ URL on win32", () => {
    expect(shouldUsePowerShellDownload(jdymusicUrl, "win32")).toBe(true);
  });

  it("returns false for /jdymusic/ URL on linux", () => {
    expect(shouldUsePowerShellDownload(jdymusicUrl, "linux")).toBe(false);
  });

  it("returns false for /jdymusic/ URL on darwin", () => {
    expect(shouldUsePowerShellDownload(jdymusicUrl, "darwin")).toBe(false);
  });

  it("returns false for new-format /jd-musicrep-ts/ URL on win32", () => {
    expect(shouldUsePowerShellDownload(newCdnUrl, "win32")).toBe(false);
  });

  it("returns false for /ymusic/ URL on win32", () => {
    expect(shouldUsePowerShellDownload(ymusicUrl, "win32")).toBe(false);
  });

  it("returns false for unrelated URLs", () => {
    expect(shouldUsePowerShellDownload("https://example.com/x.mp3", "win32")).toBe(false);
  });
});

describe("cleanupTempDir", () => {
  it("removes a directory and its contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsbot-test-"));
    writeFileSync(join(dir, "song.mp3"), "fake-bytes");
    expect(existsSync(dir)).toBe(true);
    cleanupTempDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("does not throw when directory does not exist", () => {
    const missing = join(tmpdir(), "tsbot-test-does-not-exist-xyz");
    expect(() => cleanupTempDir(missing)).not.toThrow();
  });

  it("does not throw when called twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsbot-test-"));
    cleanupTempDir(dir);
    expect(() => cleanupTempDir(dir)).not.toThrow();
  });
});

describe("shouldEndOnStall (#89 mid-track stall watchdog)", () => {
  const MAX_EMPTY = 250; // ~5s near-end threshold
  const MAX_STALL = 3000; // ~60s far-from-end watchdog

  it("ends quickly near the end once the empty threshold is reached (normal EOF)", () => {
    expect(shouldEndOnStall(MAX_EMPTY, true, MAX_EMPTY, MAX_STALL)).toBe(true);
    expect(shouldEndOnStall(MAX_EMPTY - 1, true, MAX_EMPTY, MAX_STALL)).toBe(false);
  });

  it("does NOT end far from the end at the near-end threshold (avoids false skips on transient underruns)", () => {
    // This is the core regression: a brief underrun mid-song must not end the track.
    expect(shouldEndOnStall(MAX_EMPTY, false, MAX_EMPTY, MAX_STALL)).toBe(false);
    expect(shouldEndOnStall(MAX_STALL - 1, false, MAX_EMPTY, MAX_STALL)).toBe(false);
  });

  it("eventually ends far from the end once the long stall watchdog trips (dead stream recovers)", () => {
    // The pre-fix bug: far-from-end stalls grew unbounded and never ended -> permanent silence.
    expect(shouldEndOnStall(MAX_STALL, false, MAX_EMPTY, MAX_STALL)).toBe(true);
    expect(shouldEndOnStall(MAX_STALL + 500, false, MAX_EMPTY, MAX_STALL)).toBe(true);
  });

  it("never ends before any threshold", () => {
    expect(shouldEndOnStall(0, true, MAX_EMPTY, MAX_STALL)).toBe(false);
    expect(shouldEndOnStall(10, false, MAX_EMPTY, MAX_STALL)).toBe(false);
  });
});
