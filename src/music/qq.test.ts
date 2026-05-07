import { describe, it, expect } from "vitest";
import { mapQqAlbums } from "./qq.js";

describe("QQ adapter", () => {
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
