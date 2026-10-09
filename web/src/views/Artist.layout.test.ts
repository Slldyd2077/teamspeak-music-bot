import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = () => readFileSync(join(currentDir, "Artist.vue"), "utf8");

describe("Artist page layout", () => {
  it("has no 全部歌曲 browser section (play buttons queue the catalogue instead)", () => {
    const src = source();

    expect(src).not.toContain("全部歌曲</h2>");
    expect(src).not.toContain("加载更多");
    expect(src).not.toContain("加载全部歌曲");
    expect(src).not.toContain("ALL_SONGS_PAGE");
    expect(src).not.toContain("loadMoreSongs");
    expect(src).not.toContain("allSongs");
  });

  it("keeps the hot songs and album sections", () => {
    const src = source();

    expect(src).toContain("热门歌曲");
    expect(src).toContain("专辑");
    expect(src).toContain("显示全部");
  });

  it("plays through playArtist without an all flag (the server always loads everything)", () => {
    const src = source();

    expect(src).toContain("store.playArtist(artistId(), platform.value)");
    expect(src).not.toContain("playArtist(artistId(), platform.value, true)");
  });

  it("refetches when navigating between artists", () => {
    const src = source();

    expect(src).toContain("watch(");
    expect(src).toContain("route.params.id");
    expect(src).toContain("botId: store.activeBotId");
    expect(src).toContain("${store.activeBotId ?? ''}");
  });
});
