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

  // I5: the retry is BOUNDED — get() passes `false` on the recursive call so a
  // second 429 is NOT retried. Without that bound arg this recurses forever;
  // this test must FAIL (time out) if the `false` in `this.get(path, params, false)`
  // is removed. retry-after "0" keeps the single permitted wait instant.
  it("gives up after exactly ONE 429 retry when every call 429s (bounded, no infinite loop)", async () => {
    const auth = {
      post: vi.fn().mockResolvedValue({ data: { access_token: "t", expires_in: 3600 } }),
    } as any;
    const http = {
      get: vi.fn().mockRejectedValue({
        response: { status: 429, headers: { "retry-after": "0" } },
      }),
    } as any;
    const api = new SpotifyWebApi(() => ({ clientId: "a", clientSecret: "b" }), { http, auth });
    const out = await api.search("queen");
    // Exactly two attempts: the original + one bounded retry, then it stops.
    expect(http.get).toHaveBeenCalledTimes(2);
    // Giving up returns null from get() → search yields an empty (non-throwing) result.
    expect(out).toEqual({ songs: [], playlists: [], albums: [] });
  });

  // I5: the advised wait is capped by Math.min(retryAfter, 10). A large Retry-After
  // (999s) must still wait only 10s, proving the cap. Fake timers keep it instant
  // while letting us assert the retry fires at 10s, not before.
  it("caps the Retry-After wait at 10s (Math.min(retryAfter, 10))", async () => {
    vi.useFakeTimers();
    try {
      const auth = {
        post: vi.fn().mockResolvedValue({ data: { access_token: "t", expires_in: 3600 } }),
      } as any;
      let call = 0;
      const http = {
        get: vi.fn().mockImplementation(() => {
          call += 1;
          if (call === 1) {
            return Promise.reject({ response: { status: 429, headers: { "retry-after": "999" } } });
          }
          return Promise.resolve({
            data: { tracks: { items: [{ id: "t1", name: "n", artists: [], duration_ms: 1000 }] } },
          });
        }),
      } as any;
      const api = new SpotifyWebApi(() => ({ clientId: "a", clientSecret: "b" }), { http, auth });
      const p = api.search("queen");

      // Let the token fetch + first (429) call settle and schedule the wait.
      await vi.advanceTimersByTimeAsync(9_000); // 9s < cap → retry has NOT fired yet
      expect(http.get).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000); // now 10s total → cap reached, retry fires
      const out = await p;
      expect(http.get).toHaveBeenCalledTimes(2);
      expect(out.songs[0].id).toBe("t1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns empty results when unconfigured (no creds → no token)", async () => {
    const api = new SpotifyWebApi(() => ({ clientId: "", clientSecret: "" }));
    expect(await api.search("queen")).toEqual({ songs: [], playlists: [], albums: [] });
  });
});

// m4: the catalog fetch mappers (getTrack / getAlbumTracks / getPlaylistTracks)
// were untested. They shape raw Spotify payloads into Songs, inject album cover
// context, and drop malformed playlist rows.
describe("SpotifyWebApi catalog mappers", () => {
  /** Builds an api whose single http.get resolves the supplied payload. */
  function makeApi(payload: unknown) {
    const auth = {
      post: vi.fn().mockResolvedValue({ data: { access_token: "t", expires_in: 3600 } }),
    } as any;
    const http = { get: vi.fn().mockResolvedValue({ data: payload }) } as any;
    const api = new SpotifyWebApi(() => ({ clientId: "a", clientSecret: "b" }), { http, auth });
    return { api, http };
  }

  describe("getTrack", () => {
    it("maps a single track payload to a Song", async () => {
      const { api } = makeApi({
        id: "trk1",
        name: "Song One",
        artists: [{ name: "Alice" }, { name: "Bob" }],
        album: { name: "Album X", images: [{ url: "https://i.scdn.co/t.jpg" }] },
        duration_ms: 210000,
      });
      const s = await api.getTrack("trk1");
      expect(s).toEqual({
        id: "trk1",
        name: "Song One",
        artist: "Alice, Bob",
        album: "Album X",
        duration: 210,
        coverUrl: "https://i.scdn.co/t.jpg",
        platform: "spotify",
      });
    });

    it("returns null when the track fetch yields no data", async () => {
      const auth = {
        post: vi.fn().mockResolvedValue({ data: { access_token: "t", expires_in: 3600 } }),
      } as any;
      const http = { get: vi.fn().mockResolvedValue({ data: null }) } as any;
      const api = new SpotifyWebApi(() => ({ clientId: "a", clientSecret: "b" }), { http, auth });
      expect(await api.getTrack("nope")).toBeNull();
    });
  });

  describe("getAlbumTracks", () => {
    it("injects the album name + cover into every returned track", async () => {
      // Album-track objects omit their own album block; the album cover/name must
      // be back-filled from the album payload.
      const { api } = makeApi({
        name: "A Night at the Opera",
        images: [{ url: "https://i.scdn.co/album.jpg" }],
        tracks: {
          items: [
            { id: "a1", name: "Death on Two Legs", artists: [{ name: "Queen" }], duration_ms: 223000 },
            { id: "a2", name: "Lazing on a Sunday", artists: [{ name: "Queen" }], duration_ms: 68000 },
          ],
        },
      });
      const out = await api.getAlbumTracks("alb1");
      expect(out).toHaveLength(2);
      for (const t of out) {
        expect(t.album).toBe("A Night at the Opera");
        expect(t.coverUrl).toBe("https://i.scdn.co/album.jpg");
        expect(t.platform).toBe("spotify");
      }
      expect(out[0].id).toBe("a1");
      expect(out[0].name).toBe("Death on Two Legs");
      expect(out[1].id).toBe("a2");
    });

    it("drops null track entries and returns [] when tracks.items is absent", async () => {
      const { api: withNull } = makeApi({
        name: "Alb",
        images: [{ url: "https://i.scdn.co/c.jpg" }],
        tracks: { items: [null, { id: "ok", name: "Keep", artists: [], duration_ms: 1000 }] },
      });
      const out = await withNull.getAlbumTracks("alb1");
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe("ok");
      expect(out[0].coverUrl).toBe("https://i.scdn.co/c.jpg");

      const { api: noItems } = makeApi({ name: "Alb", images: [], tracks: {} });
      expect(await noItems.getAlbumTracks("alb1")).toEqual([]);
    });
  });

  describe("getPlaylistTracks", () => {
    it("filters null items, {track:null}, and id-less tracks (never emits an id:'' Song)", async () => {
      const { api } = makeApi({
        items: [
          null,
          { track: null },
          { track: { name: "No Id Here", artists: [], duration_ms: 1000 } }, // track present but no id
          { track: { id: "p1", name: "Real Song", artists: [{ name: "X" }], duration_ms: 1000 } },
        ],
      });
      const out = await api.getPlaylistTracks("pl1");
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe("p1");
      expect(out[0].name).toBe("Real Song");
      // Guard the specific defect: no malformed empty-id Song leaks through.
      expect(out.every((s) => s.id !== "")).toBe(true);
    });

    it("returns [] when items is absent", async () => {
      const { api } = makeApi({});
      expect(await api.getPlaylistTracks("pl1")).toEqual([]);
    });
  });
});
