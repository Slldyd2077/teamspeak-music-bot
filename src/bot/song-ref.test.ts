import { describe, it, expect } from "vitest";
import { parseSongRef, parseSelectionIndex } from "./song-ref.js";

describe("parseSongRef (#90 exact-song selection)", () => {
  it("returns null for a plain search term", () => {
    expect(parseSongRef("Die For You")).toBeNull();
    expect(parseSongRef("周杰伦 晴天")).toBeNull();
    expect(parseSongRef("")).toBeNull();
    // A bare number is NOT treated as an id (a song may be named "2002").
    expect(parseSongRef("2002")).toBeNull();
  });

  it("parses an explicit id: prefix with no platform (defer to flags)", () => {
    expect(parseSongRef("id:185868")).toEqual({ id: "185868", platform: null });
    expect(parseSongRef("ID: 004Z8Ihr0JIu5s")).toEqual({ id: "004Z8Ihr0JIu5s", platform: null });
  });

  it("parses NetEase song URLs", () => {
    expect(parseSongRef("https://music.163.com/song?id=185868")).toEqual({ id: "185868", platform: "netease" });
    expect(parseSongRef("https://music.163.com/#/song?id=185868&userid=1")).toEqual({ id: "185868", platform: "netease" });
    expect(parseSongRef("music.163.com/song/185868")).toEqual({ id: "185868", platform: "netease" });
  });

  it("parses QQ song URLs", () => {
    expect(parseSongRef("https://y.qq.com/n/ryqq/songDetail/004Z8Ihr0JIu5s")).toEqual({ id: "004Z8Ihr0JIu5s", platform: "qq" });
    expect(parseSongRef("https://y.qq.com/n/yqq/song/abc.html?songmid=004Z8Ihr0JIu5s")).toEqual({ id: "004Z8Ihr0JIu5s", platform: "qq" });
  });

  it("parses BiliBili BV ids (bare or in a URL)", () => {
    expect(parseSongRef("BV1yxHQeYEuE")).toEqual({ id: "BV1yxHQeYEuE", platform: "bilibili" });
    expect(parseSongRef("https://www.bilibili.com/video/BV1yxHQeYEuE")).toEqual({ id: "BV1yxHQeYEuE", platform: "bilibili" });
    expect(parseSongRef("https://b23.tv/BV1yxHQeYEuE")).toEqual({ id: "BV1yxHQeYEuE", platform: "bilibili" });
  });
});

describe("parseSelectionIndex (#90 pick from last search)", () => {
  it("parses #N tokens (1-based)", () => {
    expect(parseSelectionIndex("#1")).toBe(1);
    expect(parseSelectionIndex("#2")).toBe(2);
    expect(parseSelectionIndex("# 3")).toBe(3);
    expect(parseSelectionIndex("  #10  ")).toBe(10);
  });

  it("rejects non-selections", () => {
    expect(parseSelectionIndex("2")).toBeNull();
    expect(parseSelectionIndex("#0")).toBeNull();
    expect(parseSelectionIndex("#-1")).toBeNull();
    expect(parseSelectionIndex("Die For You")).toBeNull();
    expect(parseSelectionIndex("#2 extra")).toBeNull();
    expect(parseSelectionIndex("")).toBeNull();
  });
});
