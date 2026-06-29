import { describe, it, expect } from "vitest";
import { mapQqAlbums, mapQqSongs, parseQqTrial } from "./qq.js";

describe("QQ adapter", () => {
  it("mapQqSongs maps QQMusicApi-style song entries", () => {
    const out = mapQqSongs([
      {
        mid: "001abc",
        name: "Radar Song",
        singer: [{ name: "Singer A" }, { name: "Singer B" }],
        album: { name: "Album A", mid: "alb001" },
        interval: 243,
      },
    ]);

    expect(out).toEqual([
      {
        id: "001abc",
        name: "Radar Song",
        artist: "Singer A / Singer B",
        album: "Album A",
        duration: 243,
        coverUrl: "https://y.gtimg.cn/music/photo_new/T002R300x300M000alb001.jpg",
        platform: "qq",
        vip: false,
      },
    ]);
  });

  it("mapQqSongs maps pay field to vip flag", () => {
    const out = mapQqSongs([
      { mid: "v1", name: "VIP playplay", singer: [], album: {}, interval: 100, pay: { payplay: 1, paytrackprice: 0 } },
      { mid: "v2", name: "VIP trackprice", singer: [], album: {}, interval: 100, pay: { payplay: 0, paytrackprice: 1 } },
      { mid: "f1", name: "Free", singer: [], album: {}, interval: 100, pay: { payplay: 0, paytrackprice: 0 } },
      { mid: "f2", name: "No pay field", singer: [], album: {}, interval: 100 },
    ]);
    expect(out[0].vip).toBe(true);
    expect(out[1].vip).toBe(true);
    expect(out[2].vip).toBe(false);
    expect(out[3].vip).toBe(false);
  });

  it("parseQqTrial maps isTryout/tryout to trial seconds", () => {
    // 非试听（VIP/免费）
    expect(parseQqTrial({ isTryout: 0 })).toBeUndefined();
    expect(parseQqTrial({})).toBeUndefined();
    // 试听（秒）
    expect(parseQqTrial({ isTryout: 1, tryBegin: 0, tryEnd: 30 })).toBe(30);
    expect(parseQqTrial({ tryout: true, begin: 0, end: 45 })).toBe(45);
    // 毫秒兜底
    expect(parseQqTrial({ isTryout: 1, tryBegin: 0, tryEnd: 30000 })).toBe(30);
    // 异常
    expect(parseQqTrial({ isTryout: 1, tryEnd: 0 })).toBeUndefined();
  });

  it("mapQqAlbums maps albumMID-style raw entries", () => {
    const raw = [
      {
        albumMID: "abc",
        albumName: "Aero",
        singerName: "Singer A",
      },
      {
        albumMID: "xyz",
        albumName: "Beta",
        singer: [{ name: "Singer B" }, { name: "Singer C" }],
      },
    ];
    const out = mapQqAlbums(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "abc",
      name: "Aero",
      artist: "Singer A",
      platform: "qq",
    });
    expect(out[0].coverUrl).toContain("T002R300x300M000abc.jpg");
    expect(out[1].artist).toBe("Singer B / Singer C");
    expect(out[1].coverUrl).toContain("xyz");
  });

  it("mapQqAlbums returns [] for empty/null input", () => {
    expect(mapQqAlbums([])).toEqual([]);
    expect(mapQqAlbums(null as any)).toEqual([]);
    expect(mapQqAlbums(undefined as any)).toEqual([]);
  });

  it("mapQqAlbums falls back to albumPic when no albumMID", () => {
    const raw = [{ albumName: "C", albumPic: "https://x/p.jpg", singerName: "S" }];
    const out = mapQqAlbums(raw);
    expect(out[0].coverUrl).toBe("https://x/p.jpg");
    expect(out[0].id).toBe("");
  });
});
