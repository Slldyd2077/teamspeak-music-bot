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
