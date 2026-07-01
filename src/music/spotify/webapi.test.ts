import { describe, it, expect, vi } from "vitest";
import {
  mapSpotifyTrack,
  mapSpotifyTracks,
  mapSpotifyAlbum,
  mapSpotifyPlaylist,
  isSpotifyUri,
  SpotifyWebApi,
} from "./webapi.js";

describe("mapSpotifyTrack", () => {
  // Shape trimmed from GET /v1/search?type=track.
  const raw = {
    id: "4iV5W9uYEdYUVa79Axb7Rh",
    name: "Bohemian Rhapsody",
    artists: [{ name: "Queen" }],
    album: { name: "A Night at the Opera", images: [{ url: "https://i.scdn.co/x.jpg" }] },
    duration_ms: 354320,
  };

  it("maps a track to a Song with platform 'spotify' and seconds duration", () => {
    const s = mapSpotifyTrack(raw);
    expect(s.platform).toBe("spotify");
    expect(s.id).toBe("4iV5W9uYEdYUVa79Axb7Rh");
    expect(s.name).toBe("Bohemian Rhapsody");
    expect(s.artist).toBe("Queen");
    expect(s.album).toBe("A Night at the Opera");
    expect(s.duration).toBe(354); // 354320ms → 354s
    expect(s.coverUrl).toBe("https://i.scdn.co/x.jpg");
  });

  it("joins multiple artists with ', '", () => {
    const s = mapSpotifyTrack({ ...raw, artists: [{ name: "A" }, { name: "B" }] });
    expect(s.artist).toBe("A, B");
  });

  it("tolerates missing fields", () => {
    const s = mapSpotifyTrack({});
    expect(s.id).toBe("");
    expect(s.name).toBe("Unknown");
    expect(s.artist).toBe("");
    expect(s.duration).toBe(0);
    expect(s.coverUrl).toBe("");
    expect(s.platform).toBe("spotify");
  });

  it("mapSpotifyTracks returns [] for non-array input", () => {
    expect(mapSpotifyTracks(undefined as any)).toEqual([]);
  });
});

describe("mapSpotifyAlbum", () => {
  it("maps an album with total_tracks → songCount", () => {
    const a = mapSpotifyAlbum({
      id: "1abc",
      name: "A Night at the Opera",
      artists: [{ name: "Queen" }],
      images: [{ url: "https://i.scdn.co/a.jpg" }],
      total_tracks: 12,
    });
    expect(a).toEqual({
      id: "1abc",
      name: "A Night at the Opera",
      artist: "Queen",
      coverUrl: "https://i.scdn.co/a.jpg",
      songCount: 12,
      platform: "spotify",
    });
  });
});

describe("mapSpotifyPlaylist", () => {
  it("maps a playlist with tracks.total → songCount", () => {
    const p = mapSpotifyPlaylist({
      id: "37i9",
      name: "Today's Top Hits",
      images: [{ url: "https://i.scdn.co/p.jpg" }],
      tracks: { total: 50 },
    });
    expect(p).toEqual({
      id: "37i9",
      name: "Today's Top Hits",
      coverUrl: "https://i.scdn.co/p.jpg",
      songCount: 50,
      platform: "spotify",
    });
  });
});

describe("isSpotifyUri", () => {
  it("recognizes the sentinel URI", () => {
    expect(isSpotifyUri("spotify:track:4iV5W9uYEdYUVa79Axb7Rh")).toBe(true);
    expect(isSpotifyUri("https://music.126.net/x.mp3")).toBe(false);
    expect(isSpotifyUri("")).toBe(false);
  });
});

describe("SpotifyWebApi rate-limit handling", () => {
  it("retries once on 429 (honoring Retry-After) then returns data", async () => {
    const auth = {
      post: vi.fn().mockResolvedValue({ data: { access_token: "t", expires_in: 3600 } }),
    } as any;
    let call = 0;
    const http = {
      get: vi.fn().mockImplementation(() => {
        call += 1;
        if (call === 1) {
          return Promise.reject({ response: { status: 429, headers: { "retry-after": "0" } } });
        }
        return Promise.resolve({
          data: { tracks: { items: [{ id: "t1", name: "n", artists: [], duration_ms: 1000 }] } },
        });
      }),
    } as any;
    const api = new SpotifyWebApi(() => ({ clientId: "a", clientSecret: "b" }), { http, auth });
    const out = await api.search("queen");
    expect(http.get).toHaveBeenCalledTimes(2); // one 429, one success
    expect(out.songs[0].id).toBe("t1");
  });

  it("returns empty results when unconfigured (no creds → no token)", async () => {
    const api = new SpotifyWebApi(() => ({ clientId: "", clientSecret: "" }));
    expect(await api.search("queen")).toEqual({ songs: [], playlists: [], albums: [] });
  });
});
