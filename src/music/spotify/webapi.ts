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
