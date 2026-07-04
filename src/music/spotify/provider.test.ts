import { describe, it, expect, vi } from "vitest";
import { SpotifyProvider } from "./provider.js";
import { SpotifyWebApi } from "./webapi.js";

function fakeApi(over: Partial<SpotifyWebApi> = {}): SpotifyWebApi {
  return {
    hasCreds: () => true,
    setCreds: vi.fn(),
    search: vi.fn().mockResolvedValue({ songs: [], playlists: [], albums: [] }),
    getTrack: vi.fn().mockResolvedValue(null),
    getAlbumTracks: vi.fn().mockResolvedValue([]),
    getPlaylistTracks: vi.fn().mockResolvedValue([]),
    ...over,
  } as unknown as SpotifyWebApi;
}

describe("SpotifyProvider", () => {
  it("has platform 'spotify'", () => {
    expect(new SpotifyProvider(fakeApi()).platform).toBe("spotify");
  });

  it("getSongUrl returns the spotify: sentinel, not a real URL", async () => {
    const p = new SpotifyProvider(fakeApi());
    const r = await p.getSongUrl("4iV5W9uYEdYUVa79Axb7Rh");
    expect(r).toEqual({ url: "spotify:track:4iV5W9uYEdYUVa79Axb7Rh" });
  });

  it("search delegates to the web API", async () => {
    const api = fakeApi({
      search: vi.fn().mockResolvedValue({
        songs: [{ id: "t1", platform: "spotify" }],
        playlists: [],
        albums: [],
      }),
    });
    const out = await new SpotifyProvider(api).search("queen", 5);
    expect(api.search).toHaveBeenCalledWith("queen", 5);
    expect(out.songs[0].id).toBe("t1");
  });

  it("getAuthStatus reflects credential presence", async () => {
    expect((await new SpotifyProvider(fakeApi({ hasCreds: () => true })).getAuthStatus()).loggedIn).toBe(true);
    expect((await new SpotifyProvider(fakeApi({ hasCreds: () => false })).getAuthStatus()).loggedIn).toBe(false);
  });

  it("getPlaylistSongs / getAlbumSongs delegate to the web API", async () => {
    const api = fakeApi({
      getPlaylistTracks: vi.fn().mockResolvedValue([{ id: "p", platform: "spotify" }]),
      getAlbumTracks: vi.fn().mockResolvedValue([{ id: "a", platform: "spotify" }]),
    });
    const p = new SpotifyProvider(api);
    expect((await p.getPlaylistSongs("37i9"))[0].id).toBe("p");
    expect((await p.getAlbumSongs("1abc"))[0].id).toBe("a");
  });

  it("no-op auth surfaces (QR expired, empty lyrics/recommend)", async () => {
    const p = new SpotifyProvider(fakeApi());
    expect(await p.getLyrics("x")).toEqual([]);
    expect(await p.getRecommendPlaylists()).toEqual([]);
    expect((await p.getQrCode()).key).toBe("");
    expect(await p.checkQrCodeStatus("k")).toBe("expired");
  });
});
