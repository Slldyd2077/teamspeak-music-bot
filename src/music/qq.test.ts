import { describe, it, expect, vi, beforeEach } from "vitest";

// All axios.create(...) instances in qq.ts (qqMusicuApi / qqSearchApi / qqFavApi
// and the per-instance api) share this single mock so the search test can
// inspect the outgoing params/body regardless of which client issued them.
const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock("axios", () => ({
  default: { create: () => ({ get: mockGet, post: mockPost }) },
}));

import { mapQqAlbums, mapQqSongs, parseQqTrial, QQMusicProvider } from "./qq.js";

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

describe("QQMusicProvider.search pagination", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  /** musicu.fcg returns one song → primary path succeeds. */
  function musicuOk() {
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/cgi-bin/musicu.fcg") {
        return {
          data: {
            req_0: { data: { body: { song: { list: [{ mid: "m1", name: "S", singer: [], album: {}, interval: 100 }] } } } },
            req_album: { data: { body: { album: { list: [] } } } },
            req_playlist: { data: { body: { songlist: { list: [] } } } },
          },
        };
      }
      return { data: {} };
    });
  }

  function musicuReqData() {
    const call = mockGet.mock.calls.find((c: any[]) => c[0] === "/cgi-bin/musicu.fcg");
    expect(call, "expected a musicu.fcg call").toBeTruthy();
    return JSON.parse(call![1].params.data);
  }

  it("adds page_num (offset/limit+1) and limit-driven num_per_page for songs/albums/playlists", async () => {
    musicuOk();
    const p = new QQMusicProvider("http://x");
    await p.search("hello", 20, 20); // page 2

    const d = musicuReqData();
    expect(d.req_0.param.page_num).toBe(2);
    expect(d.req_0.param.num_per_page).toBe(20);
    // Albums/playlists: num_per_page must be limit-driven (NOT hardcoded 10).
    expect(d.req_album.param.page_num).toBe(2);
    expect(d.req_album.param.num_per_page).toBe(20);
    expect(d.req_playlist.param.page_num).toBe(2);
    expect(d.req_playlist.param.num_per_page).toBe(20);
  });

  it("defaults offset to 0 → page_num 1 (backward compatible)", async () => {
    musicuOk();
    const p = new QQMusicProvider("http://x");
    await p.search("hello", 20);
    const d = musicuReqData();
    expect(d.req_0.param.page_num).toBe(1);
  });

  it("fallback client_search_cp sets p to the page cursor", async () => {
    // musicu returns no songs → primary returns null → fallback runs.
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/cgi-bin/musicu.fcg") {
        return { data: { req_0: { data: { body: { song: { list: [] } } } } } };
      }
      // client_search_cp
      return { data: { data: { song: { list: [] }, album: { list: [] } } } };
    });
    const p = new QQMusicProvider("http://x");
    await p.search("hello", 20, 20); // page 2

    const songCall = mockGet.mock.calls.find(
      (c: any[]) => c[0] === "/soso/fcgi-bin/client_search_cp" && c[1]?.params?.type === 0
    );
    expect(songCall, "expected a client_search_cp song call").toBeTruthy();
    expect(songCall![1].params.p).toBe(2);
  });
});
