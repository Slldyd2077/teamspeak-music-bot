import { describe, it, expect, vi } from "vitest";
import { parseLyrics, mapNeteaseAlbums, mapNeteaseSongs, parseNeteaseTrial, NeteaseProvider } from "./netease.js";

describe("NetEase adapter", () => {
  it("parses LRC format lyrics", () => {
    const lrc = `[00:00.00] 作词 : 周杰伦
[00:01.00] 作曲 : 周杰伦
[00:12.50]故事的小黄花
[00:15.80]从出生那年就飘着`;

    const lines = parseLyrics(lrc);
    expect(lines).toHaveLength(2);
    expect(lines[0].time).toBeCloseTo(12.5, 1);
    expect(lines[0].text).toBe("故事的小黄花");
    expect(lines[1].time).toBeCloseTo(15.8, 1);
    expect(lines[1].text).toBe("从出生那年就飘着");
  });

  it("handles empty lyrics", () => {
    const lines = parseLyrics("");
    expect(lines).toHaveLength(0);
  });

  it("merges translation lyrics", () => {
    const lrc = "[00:12.50]Hello world";
    const tlyric = "[00:12.50]你好世界";
    const lines = parseLyrics(lrc, tlyric);
    expect(lines[0].text).toBe("Hello world");
    expect(lines[0].translation).toBe("你好世界");
  });

  it("mapNeteaseAlbums maps raw cloudsearch albums to Album shape", () => {
    const raw = [
      {
        id: 42,
        name: "Album A",
        picUrl: "https://x/p.jpg",
        artists: [{ name: "Artist X" }, { name: "Featured Y" }],
        size: 12,
      },
      {
        id: 99,
        name: "Album B",
        picUrl: "",
        artists: [],
      },
    ];
    expect(mapNeteaseAlbums(raw)).toEqual([
      { id: "42", name: "Album A", artist: "Artist X / Featured Y", coverUrl: "https://x/p.jpg", songCount: 12, platform: "netease" },
      { id: "99", name: "Album B", artist: "", coverUrl: "", songCount: 0, platform: "netease" },
    ]);
  });

  it("mapNeteaseAlbums returns [] for empty/null input", () => {
    expect(mapNeteaseAlbums([])).toEqual([]);
    expect(mapNeteaseAlbums(null as any)).toEqual([]);
    expect(mapNeteaseAlbums(undefined as any)).toEqual([]);
  });

  it("mapNeteaseSongs maps fee to vip flag (1/4 = vip, 0/8 = free)", () => {
    const raw = [
      { id: 1, name: "VIP", ar: [{ name: "A" }], al: { name: "Al", picUrl: "p" }, dt: 180000, fee: 1 },
      { id: 2, name: "Album-only", ar: [], al: { name: "Al", picUrl: "" }, dt: 0, fee: 4 },
      { id: 3, name: "Free", ar: [], al: {}, dt: 0, fee: 0 },
      { id: 4, name: "Free low-quality", ar: [], al: {}, dt: 0, fee: 8 },
    ];
    const out = mapNeteaseSongs(raw);
    expect(out[0].vip).toBe(true);
    expect(out[1].vip).toBe(true);
    expect(out[2].vip).toBe(false);
    expect(out[3].vip).toBe(false); // fee=8 plays in full (low quality), NOT vip
  });

  it("mapNeteaseSongs accepts artists/album/duration aliases (personal_fm shape)", () => {
    const out = mapNeteaseSongs([
      { id: 9, name: "FM", artists: [{ name: "B" }], album: { name: "Al2", picUrl: "p2" }, duration: 200000, fee: 0 },
    ]);
    expect(out[0]).toMatchObject({ artist: "B", album: "Al2", coverUrl: "p2", vip: false });
  });

  it("parseNeteaseTrial maps freeTrialInfo to trial seconds", () => {
    // 无试听（VIP/免费）
    expect(parseNeteaseTrial({})).toBeUndefined();
    expect(parseNeteaseTrial({ freeTrialInfo: null })).toBeUndefined();
    // 标准秒
    expect(parseNeteaseTrial({ freeTrialInfo: { start: 0, end: 30 } })).toBe(30);
    expect(parseNeteaseTrial({ freeTrialInfo: { start: 5, end: 35 } })).toBe(30);
    // 别名容忍 begin/trialBegin
    expect(parseNeteaseTrial({ freeTrialInfo: { begin: 0, end: 30 } })).toBe(30);
    // 毫秒兜底（end>1000）
    expect(parseNeteaseTrial({ freeTrialInfo: { start: 0, end: 30000 } })).toBe(30);
    // 异常 end<=start
    expect(parseNeteaseTrial({ freeTrialInfo: { start: 0, end: 0 } })).toBeUndefined();
  });
});

describe("NeteaseProvider.search pagination", () => {
  function mockProvider() {
    const p = new NeteaseProvider("http://x");
    const get = vi.fn().mockResolvedValue({
      data: { result: { songs: [], playlists: [], albums: [] } },
    });
    (p as any).api = { get };
    return { p, get };
  }

  /** Find the /cloudsearch call whose params.type matches. */
  function callByType(get: ReturnType<typeof vi.fn>, type: number) {
    const call = get.mock.calls.find((c: any[]) => c[1]?.params?.type === type);
    expect(call, `expected a /cloudsearch call with type=${type}`).toBeTruthy();
    return call![1].params as Record<string, unknown>;
  }

  it("forwards offset for songs and uses real limit+offset for playlists/albums", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 20, 20);

    // songs (type 1): offset forwarded, limit unchanged
    const songs = callByType(get, 1);
    expect(songs.limit).toBe(20);
    expect(songs.offset).toBe(20);

    // playlists (type 1000): limit-driven (NOT hardcoded 10) + offset
    const playlists = callByType(get, 1000);
    expect(playlists.limit).toBe(20);
    expect(playlists.offset).toBe(20);

    // albums (type 10): limit-driven (NOT hardcoded 10) + offset
    const albums = callByType(get, 10);
    expect(albums.limit).toBe(20);
    expect(albums.offset).toBe(20);
  });

  it("defaults offset to 0 (backward compatible)", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 20);
    expect(callByType(get, 1).offset).toBe(0);
    expect(callByType(get, 1000).offset).toBe(0);
    expect(callByType(get, 10).offset).toBe(0);
  });
});
