import axios, { type AxiosInstance } from "axios";
import type { Song, Album, Playlist, SearchResult } from "../provider.js";

export interface SpotifyCreds {
  clientId: string;
  clientSecret: string;
}

const ACCOUNTS_BASE = "https://accounts.spotify.com";
const API_BASE = "https://api.spotify.com";

// Spotify pages collection tracks at 100 (playlists) / 50 (albums). Follow the
// paging links, but bound the fan-out so a pathological 10k-track collection
// can't explode into dozens of API calls; stop once the cap is reached.
const PLAYLIST_PAGE_SIZE = 100;
const ALBUM_PAGE_SIZE = 50;
const MAX_PLAYLIST_TRACKS = 500;
const MAX_ALBUM_TRACKS = 500;

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
        // Retry-After may be a non-numeric HTTP-date or empty string; Number(...)
        // then yields NaN/0 and fires the single retry at 0ms, ignoring the advised
        // backoff. Guard for a finite positive value (mirrors connect-api.ts).
        const raw = Number(err.response?.headers?.["retry-after"]);
        const retryAfter = Number.isFinite(raw) && raw > 0 ? raw : 1;
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
      // Mirror the album/playlist filtering: a null entry (unavailable/relinked
      // track) must not become a bogus id:'' "Unknown" Song. Drop empty ids too.
      songs: Array.isArray(data?.tracks?.items)
        ? data.tracks.items
            .filter(Boolean)
            .map(mapSpotifyTrack)
            .filter((s: Song) => s.id !== "")
        : [],
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

    // Page 1 (up to 50 tracks) is embedded in the album payload; the embedded
    // paging object caps at 50, so follow its `next` via the dedicated
    // /albums/{id}/tracks endpoint until exhausted or the cap is reached.
    const songs: Song[] = [];
    let page = album?.tracks;
    let offset = ALBUM_PAGE_SIZE;
    while (page && Array.isArray(page.items)) {
      for (const t of page.items.filter(Boolean)) {
        songs.push({ ...mapSpotifyTrack(t), album: albumName, coverUrl: cover });
      }
      if (!page.next || songs.length >= MAX_ALBUM_TRACKS) break;
      page = await this.get(`/v1/albums/${albumId}/tracks`, {
        limit: ALBUM_PAGE_SIZE,
        offset,
      });
      offset += ALBUM_PAGE_SIZE;
    }
    return songs.slice(0, MAX_ALBUM_TRACKS);
  }

  async getPlaylistTracks(playlistId: string): Promise<Song[]> {
    // A single limit:100 page silently truncates 100+ track playlists. Follow
    // `data.next` (advancing offset) until exhausted or the cap is reached, so a
    // 10k-track playlist can't fan out into 100 API calls.
    const songs: Song[] = [];
    for (let offset = 0; offset < MAX_PLAYLIST_TRACKS; offset += PLAYLIST_PAGE_SIZE) {
      const data = await this.get(`/v1/playlists/${playlistId}/tracks`, {
        limit: PLAYLIST_PAGE_SIZE,
        offset,
      });
      const items = data?.items;
      if (!Array.isArray(items)) break;
      // Keep the null / {track:null} / id-less filtering across ALL pages.
      const mapped = items
        .map((it: any) => it?.track)
        .filter((t: any) => t && t.id)
        .map(mapSpotifyTrack);
      songs.push(...mapped);
      if (!data.next) break;
    }
    return songs.slice(0, MAX_PLAYLIST_TRACKS);
  }
}
