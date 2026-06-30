import { describe, it, expect } from "vitest";
import { mapKugouSong, mapKugouSongs, mapKugouAlbums, krcToLrc } from "./kugou.js";
import { parseLyrics } from "./netease.js";

describe("mapKugouSongs", () => {
  it("maps the mobile-search song shape to a Song with platform 'kugou'", () => {
    // Shape captured live from mobilecdn.kugou.com/api/v3/search/song.
    const raw = {
      hash: "B3A52A7A958BF0AED0EBFBA2E9A818B7",
      album_audio_id: 32100650,
      album_id: "966846",
      songname: "晴天",
      singername: "周杰伦",
      duration: 269,
    };
    const [song] = mapKugouSongs([raw]);
    expect(song.platform).toBe("kugou");
    expect(song.name).toBe("晴天");
    expect(song.artist).toBe("周杰伦");
    expect(song.duration).toBe(269);
    // The id must round-trip hash + album_audio_id + album_id so getSongUrl
    // can resolve a stream from a search result.
    expect(song.id).toBe("b3a52a7a958bf0aed0ebfba2e9a818b7|32100650|966846");
  });

  it("treats nested audio_info durations as milliseconds and flat search durations as seconds", () => {
    // List endpoints: ms under audio_info.
    expect(mapKugouSong({ audio_info: { hash: "abc", duration: 215000 } }).duration).toBe(215);
    // Search endpoint: a long-form track's flat `duration` stays seconds (no /1000).
    expect(mapKugouSong({ hash: "abc", songname: "x", duration: 10800 }).duration).toBe(10800);
  });

  it("falls back to splitting '歌手 - 歌名' from the filename", () => {
    const song = mapKugouSong({ FileHash: "deadbeef", filename: "周杰伦 - 稻香", Duration: 200 });
    expect(song.artist).toBe("周杰伦");
    expect(song.name).toBe("稻香");
  });

  it("uses PascalCase fields from the gateway shape and skips entries with no hash", () => {
    const songs = mapKugouSongs([
      { FileHash: "aa", SongName: "n", SingerName: "s", MixSongID: 1, AlbumID: 2 },
      { songname: "no hash" } as any,
    ]);
    expect(songs).toHaveLength(1);
    expect(songs[0].id).toBe("aa|1|2");
  });

  it("returns [] for non-array input", () => {
    expect(mapKugouSongs(undefined)).toEqual([]);
  });

  it("maps the NESTED album/playlist track shape (base + audio_info)", () => {
    // Shape captured live from /album/songs (叶惠美).
    const raw = {
      base: { album_id: 966846, album_audio_id: 32100648, audio_name: "以父之名", author_name: "周杰伦" },
      audio_info: { hash: "DBC0207490EB51153EF933EF5A7E98E4", duration: 342047 },
    };
    const [song] = mapKugouSongs([raw]);
    expect(song.name).toBe("以父之名");
    expect(song.artist).toBe("周杰伦");
    expect(song.duration).toBe(342); // ms → s
    expect(song.id).toBe("dbc0207490eb51153ef933ef5a7e98e4|32100648|966846");
  });
});

describe("krcToLrc", () => {
  it("converts KRC [startMs,durMs] line timestamps + strips word timings into parseable LRC", () => {
    // Shape captured live from lyrics.kugou.com (周杰伦 - 晴天).
    const krc = [
      "[ti:晴天]",
      "[ar:周杰伦]",
      "[0,2250]<0,160,0>晴<160,160,0>天",
      "[63000,1800]<0,200,0>故<200,200,0>事",
    ].join("\n");
    const lrc = krcToLrc(krc);
    expect(lrc).toContain("[00:00.00]晴天");
    expect(lrc).toContain("[01:03.00]故事");
    expect(lrc).not.toMatch(/<\d+,\d+,\d+>/); // word timings stripped

    // And the shared LRC parser must now actually produce timed lines.
    const lines = parseLyrics(lrc);
    expect(lines.length).toBe(2);
    expect(lines[0]).toEqual({ time: 0, text: "晴天" });
    expect(lines[1].time).toBe(63);
    expect(lines[1].text).toBe("故事");
  });
});

describe("mapKugouAlbums", () => {
  it("maps album shape and normalises {size} covers to https", () => {
    const [album] = mapKugouAlbums([
      { album_id: 966846, album_name: "叶惠美", singername: "周杰伦", sizable_cover: "http://imge.kugou.com/x/{size}/abc.jpg", songcount: 11 },
    ]);
    expect(album.platform).toBe("kugou");
    expect(album.id).toBe("966846");
    expect(album.name).toBe("叶惠美");
    expect(album.coverUrl).toBe("https://imge.kugou.com/x/240/abc.jpg");
    expect(album.songCount).toBe(11);
  });
});
