# Spotify Source — Stage 1 (Metadata + Provider + Wiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `spotify` as an optional `MusicProvider` that can search and browse Spotify via the Web API and appears fully in the bot + web UI; actual audio playback is deferred to Stage 2/3 and cleanly reports "not playable yet".

**Architecture:** A new `src/music/spotify/` module hosts a `SpotifyWebApi` client (client-credentials token + catalog mappers) and a `SpotifyProvider` implementing the existing `MusicProvider` interface. `getSongUrl` returns a `spotify:track:<id>` **sentinel**; the play path recognizes it and skips with a user message instead of spawning ffmpeg. The provider is threaded through the same wiring every other source uses (`index.ts` → `BotManager` → `BotInstance`, the two web routers, and the Vue frontend).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 25, `axios`, `vitest`, Vue 3 + Pinia frontend.

## Global Constraints

- ESM project: **all relative imports use the `.js` extension** (e.g. `./webapi.js`), even from `.ts` files.
- Spotify support is **disabled by default**, opt-in, Premium-only, and unofficial/ToS-risky — Stage 1 adds no audio and must not enable anything automatically.
- Metadata endpoints used are Client-Credentials-safe: `/v1/search`, `/v1/tracks/{id}`, `/v1/albums/{id}/tracks`, `/v1/playlists/{id}/tracks` (unaffected by Spotify's 2024-11-27 cut).
- `platform` is stored as SQLite `TEXT` — **no DB migration**; only the TypeScript union on `src/data/database.ts:11` changes.
- Follow existing provider conventions: pure exported mapper functions unit-tested with captured JSON shapes (see `src/music/kugou.test.ts`); providers degrade gracefully (empty results, never throw to callers) when unconfigured — mirror `YouTubeProvider`.
- Source command flag for Spotify is `-s`. Platform id is `"spotify"`. Brand color `#1DB954`.
- Run tests with `npx vitest run <path>`; build check with `npx tsc --noEmit`.

---

## File structure

**New files**
- `src/music/spotify/webapi.ts` — Spotify Web API client + catalog→`Song`/`Album`/`Playlist` mappers + `isSpotifyUri`.
- `src/music/spotify/webapi.test.ts` — mapper + client tests.
- `src/music/spotify/provider.ts` — `SpotifyProvider implements MusicProvider`.
- `src/music/spotify/provider.test.ts` — provider tests (mocked webapi).

**Modified files**
- `src/music/provider.ts` — add `"spotify"` to the platform unions.
- `src/data/database.ts:11` — add `"spotify"` to the `PlayHistory.platform` union.
- `src/data/config.ts` — add `spotify` config block + sanitize.
- `src/bot/manager.ts` — `spotifyProvider` field/param, pass into `BotInstance`.
- `src/bot/instance.ts` — options/field, `getProviderFor`, `-s` flag, sentinel skip.
- `src/index.ts` — instantiate `SpotifyProvider`, wire creds, pass to manager + web server.
- `src/web/api/music.ts` — `getProvider` router + quality aggregation.
- `src/web/api/auth.ts` — `getProvider` router.
- `src/web/server.ts` — thread `spotifyProvider` into the two API factories.
- `web/src/stores/player.ts`, `web/src/stores/sourceTabs.ts`, `web/src/components/SourceTabs.vue`, `web/src/components/SongCard.vue`, `web/src/styles/variables.scss` — frontend plumbing.

---

## Task 1: Spotify Web API client + mappers

**Files:**
- Create: `src/music/spotify/webapi.ts`
- Test: `src/music/spotify/webapi.test.ts`
- Modify: `src/music/provider.ts` (add `"spotify"` to unions)
- Modify: `src/data/database.ts` (line 11 union)

**Interfaces:**
- Produces:
  - `mapSpotifyTrack(raw: any): Song`, `mapSpotifyTracks(raw: any[]): Song[]`, `mapSpotifyAlbum(raw: any): Album`, `mapSpotifyPlaylist(raw: any): Playlist`
  - `isSpotifyUri(url: string): boolean`
  - `interface SpotifyCreds { clientId: string; clientSecret: string }`
  - `class SpotifyWebApi` with `constructor(getCreds: () => SpotifyCreds, deps?: { http?: AxiosInstance; auth?: AxiosInstance })`, `setCreds(c: SpotifyCreds): void`, `hasCreds(): boolean`, `search(query: string, limit?: number): Promise<SearchResult>`, `getTrack(id: string): Promise<Song | null>`, `getAlbumTracks(albumId: string): Promise<Song[]>`, `getPlaylistTracks(playlistId: string): Promise<Song[]>`

- [ ] **Step 1: Add `"spotify"` to the platform unions in `src/music/provider.ts`**

In `src/music/provider.ts`, every union currently reading `"netease" | "qq" | "bilibili" | "youtube" | "local" | "kugou"` gains `| "spotify"`. There are four: `Song.platform`, `Playlist.platform`, `Album.platform`, and `MusicProvider.platform`. Change each to:

```ts
platform: "netease" | "qq" | "bilibili" | "youtube" | "local" | "kugou" | "spotify";
```

- [ ] **Step 2: Add `"spotify"` to the `PlayHistory` union in `src/data/database.ts:11`**

```ts
  platform: "netease" | "qq" | "bilibili" | "youtube" | "local" | "kugou" | "spotify";
```

- [ ] **Step 3: Write the failing mapper tests**

Create `src/music/spotify/webapi.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/music/spotify/webapi.test.ts`
Expected: FAIL — `Cannot find module './webapi.js'`.

- [ ] **Step 5: Implement `src/music/spotify/webapi.ts`**

```ts
import axios, { type AxiosInstance } from "axios";
import type { Song, Album, Playlist, SearchResult } from "../provider.js";

export interface SpotifyCreds {
  clientId: string;
  clientSecret: string;
}

const ACCOUNTS_BASE = "https://accounts.spotify.com";
const API_BASE = "https://api.spotify.com";

function artistsToString(artists: unknown): string {
  return Array.isArray(artists)
    ? artists.map((a: any) => a?.name).filter(Boolean).join(", ")
    : "";
}

/** Map a Spotify track object (search / tracks / playlist item .track) to a Song. */
export function mapSpotifyTrack(raw: any): Song {
  return {
    id: raw?.id ?? "",
    name: raw?.name ?? "Unknown",
    artist: artistsToString(raw?.artists),
    album: raw?.album?.name ?? "",
    duration: Math.round((raw?.duration_ms ?? 0) / 1000),
    coverUrl: raw?.album?.images?.[0]?.url ?? "",
    platform: "spotify",
  };
}

export function mapSpotifyTracks(raw: any): Song[] {
  return Array.isArray(raw) ? raw.map(mapSpotifyTrack) : [];
}

export function mapSpotifyAlbum(raw: any): Album {
  return {
    id: raw?.id ?? "",
    name: raw?.name ?? "Unknown",
    artist: artistsToString(raw?.artists),
    coverUrl: raw?.images?.[0]?.url ?? "",
    songCount: raw?.total_tracks ?? 0,
    platform: "spotify",
  };
}

export function mapSpotifyPlaylist(raw: any): Playlist {
  return {
    id: raw?.id ?? "",
    name: raw?.name ?? "Unknown",
    coverUrl: raw?.images?.[0]?.url ?? "",
    songCount: raw?.tracks?.total ?? 0,
    platform: "spotify",
  };
}

/** True for the getSongUrl sentinel (spotify:track:<id>); real audio lands in Stage 2/3. */
export function isSpotifyUri(url: string): boolean {
  return typeof url === "string" && url.startsWith("spotify:");
}

export class SpotifyWebApi {
  private getCreds: () => SpotifyCreds;
  private http: AxiosInstance;
  private auth: AxiosInstance;
  private token = "";
  private tokenExpiresAt = 0;

  constructor(
    getCreds: () => SpotifyCreds,
    deps?: { http?: AxiosInstance; auth?: AxiosInstance }
  ) {
    this.getCreds = getCreds;
    this.http = deps?.http ?? axios.create({ baseURL: API_BASE, timeout: 15_000 });
    this.auth = deps?.auth ?? axios.create({ baseURL: ACCOUNTS_BASE, timeout: 15_000 });
  }

  setCreds(_c: SpotifyCreds): void {
    // Creds are read live via getCreds(); force a token refresh on next call.
    this.token = "";
    this.tokenExpiresAt = 0;
  }

  hasCreds(): boolean {
    const c = this.getCreds();
    return !!c.clientId && !!c.clientSecret;
  }

  /** Client-Credentials app token, cached until ~30s before expiry. */
  private async getToken(): Promise<string | null> {
    if (!this.hasCreds()) return null;
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const { clientId, clientSecret } = this.getCreds();
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    try {
      const { data } = await this.auth.post(
        "/api/token",
        "grant_type=client_credentials",
        {
          headers: {
            Authorization: `Basic ${basic}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );
      this.token = data?.access_token ?? "";
      this.tokenExpiresAt = Date.now() + ((data?.expires_in ?? 3600) - 30) * 1000;
      return this.token || null;
    } catch {
      return null;
    }
  }

  private async get(
    path: string,
    params?: Record<string, unknown>,
    retryOn429 = true
  ): Promise<any | null> {
    const token = await this.getToken();
    if (!token) return null;
    try {
      const { data } = await this.http.get(path, {
        params,
        headers: { Authorization: `Bearer ${token}` },
      });
      return data;
    } catch (err: any) {
      // Spotify rate-limits on a rolling 30s window (429 + Retry-After seconds).
      // Retry once after the advised delay before giving up.
      if (retryOn429 && err?.response?.status === 429) {
        const retryAfter = Number(err.response.headers?.["retry-after"] ?? 1);
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
        return this.get(path, params, false);
      }
      return null;
    }
  }

  async search(query: string, limit = 20): Promise<SearchResult> {
    const data = await this.get("/v1/search", {
      q: query,
      type: "track,album,playlist",
      limit,
    });
    if (!data) return { songs: [], playlists: [], albums: [] };
    return {
      songs: mapSpotifyTracks(data?.tracks?.items),
      albums: Array.isArray(data?.albums?.items)
        ? data.albums.items.filter(Boolean).map(mapSpotifyAlbum)
        : [],
      playlists: Array.isArray(data?.playlists?.items)
        ? data.playlists.items.filter(Boolean).map(mapSpotifyPlaylist)
        : [],
    };
  }

  async getTrack(id: string): Promise<Song | null> {
    const data = await this.get(`/v1/tracks/${id}`);
    return data ? mapSpotifyTrack(data) : null;
  }

  async getAlbumTracks(albumId: string): Promise<Song[]> {
    // Album-track objects omit the album block; fetch the album cover once and inject it.
    const album = await this.get(`/v1/albums/${albumId}`);
    const cover = album?.images?.[0]?.url ?? "";
    const albumName = album?.name ?? "";
    const items = album?.tracks?.items;
    if (!Array.isArray(items)) return [];
    return items.filter(Boolean).map((t: any) => ({
      ...mapSpotifyTrack(t),
      album: albumName,
      coverUrl: cover,
    }));
  }

  async getPlaylistTracks(playlistId: string): Promise<Song[]> {
    const data = await this.get(`/v1/playlists/${playlistId}/tracks`, { limit: 100 });
    const items = data?.items;
    if (!Array.isArray(items)) return [];
    return items
      .map((it: any) => it?.track)
      .filter((t: any) => t && t.id)
      .map(mapSpotifyTrack);
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/music/spotify/webapi.test.ts`
Expected: PASS (all mapper + `isSpotifyUri` tests green).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/music/spotify/webapi.ts src/music/spotify/webapi.test.ts src/music/provider.ts src/data/database.ts
git commit -m "feat(spotify): Web API client + catalog mappers, add spotify platform"
```

---

## Task 2: SpotifyProvider

**Files:**
- Create: `src/music/spotify/provider.ts`
- Test: `src/music/spotify/provider.test.ts`

**Interfaces:**
- Consumes: `SpotifyWebApi`, `mapSpotify*`, `isSpotifyUri` (Task 1); `MusicProvider` and its DTOs (`src/music/provider.ts`).
- Produces: `class SpotifyProvider implements MusicProvider` with `constructor(api?: SpotifyWebApi)` and `setCreds(clientId: string, clientSecret: string): void`.

- [ ] **Step 1: Write the failing provider test**

Create `src/music/spotify/provider.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/music/spotify/provider.test.ts`
Expected: FAIL — `Cannot find module './provider.js'`.

- [ ] **Step 3: Implement `src/music/spotify/provider.ts`**

```ts
import type {
  MusicProvider,
  Song,
  SongUrlResult,
  Playlist,
  Album,
  SearchResult,
  LyricLine,
  QrCodeResult,
  AuthStatus,
} from "../provider.js";
import { SpotifyWebApi, type SpotifyCreds } from "./webapi.js";

export class SpotifyProvider implements MusicProvider {
  readonly platform = "spotify" as const;
  private api: SpotifyWebApi;
  private creds: SpotifyCreds = { clientId: "", clientSecret: "" };
  private quality = "320";

  constructor(api?: SpotifyWebApi) {
    this.api = api ?? new SpotifyWebApi(() => this.creds);
  }

  setCreds(clientId: string, clientSecret: string): void {
    this.creds = { clientId: clientId ?? "", clientSecret: clientSecret ?? "" };
    this.api.setCreds(this.creds);
  }

  async search(query: string, limit = 20): Promise<SearchResult> {
    return this.api.search(query, limit);
  }

  // Stage 1: return a sentinel URI. The play path recognizes `spotify:` and
  // skips with a "not playable yet" message; real audio arrives in Stage 2/3.
  async getSongUrl(songId: string): Promise<SongUrlResult | null> {
    return { url: `spotify:track:${songId}` };
  }

  setQuality(quality: string): void {
    this.quality = quality;
  }
  getQuality(): string {
    return this.quality;
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    return this.api.getTrack(songId);
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    return this.api.getPlaylistTracks(playlistId);
  }

  async getAlbumSongs(albumId: string): Promise<Song[]> {
    return this.api.getAlbumTracks(albumId);
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    return [];
  }

  async getLyrics(_songId: string): Promise<LyricLine[]> {
    return [];
  }

  async getQrCode(): Promise<QrCodeResult> {
    return { qrUrl: "", key: "" };
  }

  async checkQrCodeStatus(
    _key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    return "expired";
  }

  setCookie(_cookie: string): void {}
  getCookie(): string {
    return "";
  }

  async getAuthStatus(): Promise<AuthStatus> {
    return this.api.hasCreds()
      ? { loggedIn: true, nickname: "Spotify" }
      : { loggedIn: false, nickname: "Spotify (未配置 Client ID/Secret)" };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/music/spotify/provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/music/spotify/provider.ts src/music/spotify/provider.test.ts
git commit -m "feat(spotify): SpotifyProvider (search/browse; playback sentinel)"
```

---

## Task 3: Config block

**Files:**
- Modify: `src/data/config.ts`
- Test: `src/data/config.test.ts` (append)

**Interfaces:**
- Produces: `BotConfig.spotify: SpotifyConfig` where `interface SpotifyConfig { enabled: boolean; backend: "auto" | "go-librespot" | "librespot"; clientId: string; clientSecret: string; deviceName: string; bitrate: number }`, present in `getDefaultConfig()` and sanitized by `loadConfig`.

- [ ] **Step 1: Write the failing config tests**

`src/data/config.test.ts` **already exists** and already imports `{ describe, it, expect }` from `vitest`, `{ getDefaultConfig, loadConfig }` from `./config.js`, and `writeFileSync`/`mkdtempSync`/`tmpdir`/`join` from the node modules. **Append only the `describe` block below — do NOT add any import lines** (they would be duplicate identifiers). Add at the end of the file:

```ts
describe("spotify config", () => {
  it("defaults are present and disabled", () => {
    const c = getDefaultConfig();
    expect(c.spotify).toEqual({
      enabled: false,
      backend: "auto",
      clientId: "",
      clientSecret: "",
      deviceName: "TSMusicBot",
      bitrate: 320,
    });
  });

  it("loadConfig coerces bad spotify values back to safe defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(
      p,
      JSON.stringify({
        spotify: { enabled: "yes", backend: "bogus", bitrate: 7, clientId: 5 },
      })
    );
    const c = loadConfig(p);
    expect(c.spotify.enabled).toBe(false); // non-boolean → false
    expect(c.spotify.backend).toBe("auto"); // invalid enum → auto
    expect(c.spotify.bitrate).toBe(320); // invalid → 320
    expect(c.spotify.clientId).toBe(""); // non-string → ""
    expect(c.spotify.deviceName).toBe("TSMusicBot"); // missing → default
  });

  it("loadConfig preserves valid spotify values", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(
      p,
      JSON.stringify({
        spotify: {
          enabled: true,
          backend: "librespot",
          clientId: "abc",
          clientSecret: "def",
          deviceName: "MyBot",
          bitrate: 160,
        },
      })
    );
    const c = loadConfig(p);
    expect(c.spotify).toEqual({
      enabled: true,
      backend: "librespot",
      clientId: "abc",
      clientSecret: "def",
      deviceName: "MyBot",
      bitrate: 160,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/data/config.test.ts`
Expected: FAIL — `c.spotify` is `undefined`.

- [ ] **Step 3: Add the `SpotifyConfig` interface and default**

In `src/data/config.ts`, add the interface above `BotConfig`:

```ts
export interface SpotifyConfig {
  enabled: boolean;
  backend: "auto" | "go-librespot" | "librespot";
  clientId: string;
  clientSecret: string;
  deviceName: string;
  bitrate: number;
}
```

Add to the `BotConfig` interface (after `guestMode: GuestModeConfig;`):

```ts
  spotify: SpotifyConfig;
```

Add to the object returned by `getDefaultConfig()` (after the `guestMode: { ... }` block, inside the returned object):

```ts
    spotify: {
      enabled: false,
      backend: "auto",
      clientId: "",
      clientSecret: "",
      deviceName: "TSMusicBot",
      bitrate: 320,
    },
```

- [ ] **Step 4: Sanitize `spotify` in `loadConfig`**

In `loadConfig`, after the `adminGroups` sanitization block and before the `return { ...defaults, ...partial, adminGroups, guestMode: gm }`, add:

```ts
    const partialSp = (partial.spotify ?? {}) as Partial<SpotifyConfig>;
    const validBackends = ["auto", "go-librespot", "librespot"] as const;
    const validBitrates = [96, 160, 320];
    const spotify: SpotifyConfig = {
      enabled: partialSp.enabled === true,
      backend: (validBackends as readonly string[]).includes(partialSp.backend as string)
        ? (partialSp.backend as SpotifyConfig["backend"])
        : defaults.spotify.backend,
      clientId: typeof partialSp.clientId === "string" ? partialSp.clientId : defaults.spotify.clientId,
      clientSecret:
        typeof partialSp.clientSecret === "string" ? partialSp.clientSecret : defaults.spotify.clientSecret,
      deviceName:
        typeof partialSp.deviceName === "string" && partialSp.deviceName.trim()
          ? partialSp.deviceName
          : defaults.spotify.deviceName,
      bitrate: validBitrates.includes(partialSp.bitrate as number)
        ? (partialSp.bitrate as number)
        : defaults.spotify.bitrate,
    };
```

Then update the return statement to include it:

```ts
    return {
      ...defaults,
      ...partial,
      adminGroups,
      guestMode: gm,
      spotify,
    };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/data/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/data/config.ts src/data/config.test.ts
git commit -m "feat(spotify): config block (disabled by default) + sanitize"
```

---

## Task 4: Bot wiring (index, manager, instance) + sentinel skip

**Files:**
- Modify: `src/bot/instance.ts`
- Modify: `src/bot/manager.ts`
- Modify: `src/index.ts`
- Test: `src/bot/instance.test.ts` (append a routing test)

**Interfaces:**
- Consumes: `SpotifyProvider` (Task 2), `isSpotifyUri` (Task 1), `MusicProvider`.
- Produces: `BotInstance.getProviderFor("spotify")` returns the spotify provider; `-s` flag selects it; the play path skips `spotify:` sentinels.

- [ ] **Step 1: Write a failing routing test**

`src/bot/instance.test.ts` tests methods by invoking them on a hand-built context via `.call(ctx)` (there is no bot factory). `getProviderFor` only reads `this.<provider>` fields, so a minimal `ctx` suffices. `BotInstance` is already imported in this file — reuse that import. Append:

```ts
it("getProviderFor routes 'spotify' to the injected spotify provider", () => {
  const spotify = { platform: "spotify" } as any;
  const ctx = { spotifyProvider: spotify, neteaseProvider: { platform: "netease" } } as any;
  expect(BotInstance.prototype.getProviderFor.call(ctx, "spotify" as any)).toBe(spotify);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/bot/instance.test.ts -t "routes 'spotify'"`
Expected: FAIL — before the branch exists, `getProviderFor("spotify")` falls through to `this.neteaseProvider`, so the returned value is not the `spotify` sentinel object.

- [ ] **Step 3: Add `spotifyProvider` to `BotInstanceOptions` and the class fields**

In `src/bot/instance.ts`, in `BotInstanceOptions` (near `kugouProvider?: MusicProvider;`):

```ts
  spotifyProvider?: MusicProvider;
```

In the class fields (near `private kugouProvider: MusicProvider;`):

```ts
  private spotifyProvider: MusicProvider;
```

In the constructor (near `this.kugouProvider = options.kugouProvider ?? options.neteaseProvider;`):

```ts
    this.spotifyProvider = options.spotifyProvider ?? options.neteaseProvider;
```

- [ ] **Step 4: Add the routing branches**

First **widen the `getProviderFor` parameter type** (line ~530) to include `spotify` — otherwise `tsc` fails (the `=== "spotify"` comparison has no type overlap, and callers now pass `song.platform` which includes `"spotify"`):

```ts
  getProviderFor(platform: "netease" | "qq" | "bilibili" | "youtube" | "local" | "kugou" | "spotify"): MusicProvider {
```

Then, in `getProviderFor` (currently ending `if (platform === "kugou") return this.kugouProvider;`), add before the final `return`:

```ts
    if (platform === "spotify") return this.spotifyProvider;
```

In `getProvider(flags)` (currently `if (flags.has("k")) return this.kugouProvider;`), add:

```ts
    if (flags.has("s")) return this.spotifyProvider;
```

- [ ] **Step 5: Skip the sentinel in the play path**

In `resolveAndPlay`, immediately after the post-resolve disconnect re-check and before `song.url = result.url;`, insert:

```ts
      // Stage 1: Spotify metadata works but audio is not wired yet. getSongUrl
      // returns a `spotify:` sentinel — never hand it to ffmpeg. Tell the user
      // and skip so the queue keeps moving. `sendTextMessage` is the same
      // channel-message helper the command handlers use elsewhere in this file.
      if (isSpotifyUri(result.url)) {
        this.logger.info({ songId: song.id, name: song.name }, "Spotify playback not enabled yet — skipping");
        await this.tsClient.sendTextMessage(
          "⚠️ Spotify 播放尚未启用（需要 librespot 音频后端，将在后续版本支持）。"
        );
        return false;
      }
```

Add the import at the top of `src/bot/instance.ts`:

```ts
import { isSpotifyUri } from "../music/spotify/webapi.js";
```

- [ ] **Step 6: Thread the provider through `BotManager`**

In `src/bot/manager.ts`: add a field near `private kugouProvider: MusicProvider;`:

```ts
  private spotifyProvider: MusicProvider;
```

Add a constructor parameter after `kugouProvider?: MusicProvider`:

```ts
    spotifyProvider?: MusicProvider,
```

Assign it near `this.kugouProvider = kugouProvider ?? neteaseProvider;`:

```ts
    this.spotifyProvider = spotifyProvider ?? neteaseProvider;
```

There are **three** `new BotInstance({ ... })` sites in `manager.ts` — `createBot` (~line 123), `startBot` (~line 259), and `loadSavedBots` (~line 316). Add the following line (after `kugouProvider: this.kugouProvider,`) to **all three** options objects:

```ts
      spotifyProvider: this.spotifyProvider,
```

> ⚠️ Missing `startBot` is silent: because the `BotInstance` constructor falls back `options.spotifyProvider ?? options.neteaseProvider`, a bot restarted from the UI would route Spotify to the NetEase provider with no error. Verify with `grep -n "new BotInstance(" src/bot/manager.ts` that all three are updated.

- [ ] **Step 7: Instantiate + wire in `src/index.ts`**

Add the import near the other providers:

```ts
import { SpotifyProvider } from "./music/spotify/provider.js";
```

After `const kugouProvider = new KugouProvider();`:

```ts
  const spotifyProvider = new SpotifyProvider();
  // Safety gate (spec §7): the source is inert unless EXPLICITLY enabled.
  // Only feed credentials when enabled — otherwise the provider has no creds,
  // hasCreds() is false, search returns empty, and getAuthStatus() is loggedIn:false,
  // so setting a Client ID/Secret alone (enabled:false) never activates Spotify.
  if (config.spotify.enabled && config.spotify.clientId) {
    spotifyProvider.setCreds(config.spotify.clientId, config.spotify.clientSecret);
  }
```

Add `spotifyProvider` as the last argument to `new BotManager(...)` (after `kugouProvider`):

```ts
    kugouProvider,
    spotifyProvider
```

Add `spotifyProvider,` to the `createWebServer({ ... })` options object (after `kugouProvider,`).

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run src/bot` then `npx tsc --noEmit`
Expected: PASS / no errors. (If `manager.test.ts` constructs `BotManager` positionally, the new trailing optional param is backward-compatible.)

- [ ] **Step 9: Commit**

```bash
git add src/bot/instance.ts src/bot/manager.ts src/index.ts src/bot/instance.test.ts
git commit -m "feat(spotify): wire provider through manager/instance; skip playback sentinel"
```

---

## Task 5: Web API routers

**Files:**
- Modify: `src/web/api/music.ts`
- Modify: `src/web/api/auth.ts`
- Modify: `src/web/server.ts`

**Interfaces:**
- Consumes: the `spotifyProvider` created in `index.ts` (Task 4).
- Produces: `getProvider("spotify")` resolves the spotify provider in both API routers; `/api/music/quality` includes `spotify`.

- [ ] **Step 1: Accept `spotifyProvider` in the music router factory**

In `src/web/api/music.ts`, add `spotifyProvider` to the factory's options/params (mirror how `kugouProvider` is accepted). In `getProvider(platform)`, add before the final `return`:

```ts
    if (platform === "spotify" && spotifyProvider) return spotifyProvider;
```

In the `GET /quality` response object, add:

```ts
      spotify: spotifyProvider?.getQuality() ?? "320",
```

In `POST /quality`, add:

```ts
    if ((!platform || platform === "spotify") && spotifyProvider) {
      spotifyProvider.setQuality(quality);
    }
```

- [ ] **Step 2: Accept `spotifyProvider` in the auth router factory**

In `src/web/api/auth.ts`, add `spotifyProvider` to the factory params and, in `getProvider(platform)`, add before the final `return`:

```ts
    if (platform === "spotify" && spotifyProvider) return spotifyProvider;
```

- [ ] **Step 3: Thread `spotifyProvider` from `server.ts`**

`src/web/server.ts` does not destructure options — it reads `options.X` and passes providers **positionally**. Do two things:
1. Add `spotifyProvider: MusicProvider;` to the `WebServerOptions` interface (required, mirroring `kugouProvider` which has no `?`).
2. Pass `options.spotifyProvider` as the **trailing positional argument** to both `createMusicRouter(...)` and `createAuthRouter(...)` (after the existing `options.kugouProvider` argument). `index.ts` already supplies `spotifyProvider` in the `createWebServer({ ... })` options (Task 4 Step 7).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the web API tests**

Run: `npx vitest run src/web`
Expected: PASS (existing tests unaffected; the new optional param is backward-compatible).

- [ ] **Step 6: Commit**

```bash
git add src/web/api/music.ts src/web/api/auth.ts src/web/server.ts
git commit -m "feat(spotify): expose provider through web music/auth routers"
```

---

## Task 6: Frontend plumbing

**Files:**
- Modify: `web/src/stores/player.ts`
- Modify: `web/src/stores/sourceTabs.ts`
- Modify: `web/src/components/SourceTabs.vue`
- Modify: `web/src/components/SongCard.vue`
- Modify: `web/src/styles/variables.scss`
- Test: `web/src/stores/sourceTabs.test.ts` (if present; else skip the test step)

**Interfaces:**
- Produces: `spotify` is a valid `Source`, has a tab, a green badge, and an auth-status slot.

- [ ] **Step 1: Extend the store unions and maps in `web/src/stores/player.ts`**

Line ~13 — `Song.platform` union: add `| 'spotify'`:

```ts
  platform: 'netease' | 'qq' | 'bilibili' | 'youtube' | 'local' | 'kugou' | 'spotify';
```

Line ~16 — `Source` type: add `'spotify'`:

```ts
export type Source = 'netease' | 'qq' | 'kugou' | 'spotify';
```

Lines ~103–107 — add `spotify` to the record maps:

```ts
    recommendPlaylists: { netease: [] as PlaylistItem[], qq: [] as PlaylistItem[], kugou: [] as PlaylistItem[], spotify: [] as PlaylistItem[] },
    dailySongs:         { netease: [] as Song[],         qq: [] as Song[],         kugou: [] as Song[], spotify: [] as Song[] },
    userPlaylists:      { netease: [] as PlaylistItem[], qq: [] as PlaylistItem[], kugou: [] as PlaylistItem[], spotify: [] as PlaylistItem[] },
    authStatus: { netease: false, qq: false, kugou: false, spotify: false },
```

Line ~160 — push spotify into the source list when authed:

```ts
      if (this.authStatus.spotify) s.push('spotify');
```

Auth fetch fan-out in `fetchHomeData()` (~575–591) — the code uses `Promise.allSettled`. Extend the destructured array, the `Promise.allSettled([...])` list, the `newAuth` object, the `authChanged` check, and the assignments to include `spotify`, mirroring `kugou`:

```ts
      const [neAuthRes, qqAuthRes, kugouAuthRes, spAuthRes] = await Promise.allSettled([
        axios.get('/api/auth/status', { params: { platform: 'netease' } }),
        axios.get('/api/auth/status', { params: { platform: 'qq' } }),
        axios.get('/api/auth/status', { params: { platform: 'kugou' } }),
        axios.get('/api/auth/status', { params: { platform: 'spotify' } }),
      ]);
      const newAuth = {
        netease: neAuthRes.status === 'fulfilled' && !!neAuthRes.value.data?.loggedIn,
        qq:      qqAuthRes.status === 'fulfilled' && !!qqAuthRes.value.data?.loggedIn,
        kugou:   kugouAuthRes.status === 'fulfilled' && !!kugouAuthRes.value.data?.loggedIn,
        spotify: spAuthRes.status === 'fulfilled' && !!spAuthRes.value.data?.loggedIn,
      };
      const authChanged =
        newAuth.netease !== this.authStatus.netease ||
        newAuth.qq !== this.authStatus.qq ||
        newAuth.kugou !== this.authStatus.kugou ||
        newAuth.spotify !== this.authStatus.spotify;
      this.authStatus.netease = newAuth.netease;
      this.authStatus.qq = newAuth.qq;
      this.authStatus.kugou = newAuth.kugou;
      this.authStatus.spotify = newAuth.spotify;
```

> **Recommend/daily/userPlaylists fetch fan-out is intentionally NOT extended for `spotify` in Stage 1.** `SpotifyProvider.getRecommendPlaylists()` returns `[]` (and there are no daily/user-playlist endpoints yet), so the map slots added above stay empty and the Spotify home view is simply blank — correct for Stage 1. The recommend fan-out gets wired when those endpoints arrive in a later stage. (This consciously discharges the spec §8 "recommend fetch fan-out" item for this stage.)

- [ ] **Step 2: Accept `spotify` in `web/src/stores/sourceTabs.ts`**

Line ~31 coercion:

```ts
  return v === 'netease' || v === 'qq' || v === 'kugou' || v === 'spotify' ? v : fallback;
```

- [ ] **Step 3: Add the tab label in `web/src/components/SourceTabs.vue`**

In the label map (near `kugou: '酷狗',`):

```ts
  spotify: 'Spotify',
```

- [ ] **Step 4: Add the badge in `web/src/components/SongCard.vue`**

Extend the badge class ternary (line ~10) and label ternary (line ~11) to handle `spotify` (append before the netease fallback):

```
... : song.platform === 'kugou' ? 'badge-kugou' : song.platform === 'spotify' ? 'badge-spotify' : 'badge-netease'"
... : song.platform === 'kugou' ? '酷狗' : song.platform === 'spotify' ? 'Spotify' : '网易云' }}</span>
```

Add the style block near `.badge-kugou`:

```scss
.badge-spotify {
  background: var(--brand-spotify-12);
  color: var(--brand-spotify);
}
```

- [ ] **Step 5: Add brand colors in `web/src/styles/variables.scss`**

Near `--brand-kugou`:

```scss
  --brand-spotify: #1DB954;
  --brand-spotify-12: rgba(29, 185, 84, 0.12);
```

- [ ] **Step 6: (If it exists) update `web/src/stores/sourceTabs.test.ts`**

If a test file asserts valid sources, add a case:

```ts
it("accepts 'spotify'", () => {
  expect(coerceSource('spotify', 'netease')).toBe('spotify');
});
```

- [ ] **Step 7: Build the frontend to verify it compiles**

Run: `cd web && npm run build`
Expected: build succeeds (Vite + vue-tsc), no type errors from the new `spotify` members.

- [ ] **Step 8: Commit**

```bash
git add web/src/stores/player.ts web/src/stores/sourceTabs.ts web/src/components/SourceTabs.vue web/src/components/SongCard.vue web/src/styles/variables.scss web/src/stores/sourceTabs.test.ts
git commit -m "feat(spotify): frontend plumbing (source tab, badge, auth status)"
```

---

## Task 7: Full verification

- [ ] **Step 1: Run the entire test suite**

Run: `npx vitest run`
Expected: all tests pass (no regressions in existing suites; new spotify tests green).

- [ ] **Step 2: Typecheck backend + build frontend**

Run: `npx tsc --noEmit && cd web && npm run build`
Expected: no type errors; frontend builds.

- [ ] **Step 3: Manual smoke (documented, optional)**

With a Spotify Developer app's Client ID/Secret placed in `data/config.json` under `spotify` and `enabled: true`, start the bot (`npm run dev`), open the web UI, pick the **Spotify** tab, search a track → results render with a green badge. Queue one → the bot posts the "Spotify 播放尚未启用" message and advances. Confirms Stage 1 end-to-end without any sidecar.

- [ ] **Step 4: Final commit (if any docs/tidy)**

```bash
git add -A
git commit -m "chore(spotify): stage 1 verification pass" --allow-empty
```

---

## Self-review notes (for the plan author / reviewer)

- **Spec coverage (Stage 1 scope §12.1):** metadata client (Task 1), provider (Task 2), config (Task 3), bot wiring + graceful non-playback (Task 4), web routers (Task 5), UI plumbing (Task 6). Audio backends (§4.2/4.3), OAuth/PKCE (§5.2), binary resolution (§9), and the player external-PCM mode (§6) are intentionally **out of scope for Stage 1** and handled in later plans.
- **Sentinel type consistency:** `getSongUrl` → `{ url: \`spotify:track:${id}\` }` (Task 2) is detected by `isSpotifyUri` (Task 1) in the play path (Task 4). Names match across tasks.
- **Backward compatibility:** every new constructor/factory parameter (`spotifyProvider`) is optional/trailing, so existing positional callers and tests keep compiling.
- **Codebase-verified specifics:** the user-message call in `instance.ts` uses `await this.tsClient.sendTextMessage(...)` (the same helper the command handlers use), and the `player.ts` auth fan-out extends the real `Promise.allSettled([...])` block — both confirmed against the current source.
- **Enabled gate (spec §7):** `index.ts` feeds credentials only when `config.spotify.enabled && config.spotify.clientId`, so a Client ID/Secret with `enabled:false` leaves the source fully inert (empty search, `loggedIn:false`).
- **Adversarial verification pass (applied):** a 3-critic review against the live repo fixed — (a) widening the `getProviderFor` signature to include `spotify` (build-breaker), (b) not re-importing in the pre-existing `config.test.ts` (build-breaker), (c) updating **all three** `new BotInstance` sites incl. `startBot` (silent-miswire), (d) accurate `server.ts` positional threading, (e) the `instance.test.ts` `.call(ctx)` test shape, (f) a spec-required 429 Retry-After handler + test, and (g) dropping the unused `searchTracks`. The type/interface critic confirmed `SpotifyProvider` implements every non-optional `MusicProvider` member and all mapper outputs match the `Song`/`Album`/`Playlist` shapes exactly.
