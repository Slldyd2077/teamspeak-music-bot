import { describe, it, expect } from "vitest";
import { buildFfmpegArgs } from "./player.js";

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
