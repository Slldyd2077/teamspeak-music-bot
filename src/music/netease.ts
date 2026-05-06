import axios, { type AxiosInstance } from "axios";
import type {
  MusicProvider,
  Song,
  Playlist,
  PlaylistDetail,
  LyricLine,
  SearchResult,
  QrCodeResult,
  AuthStatus,
} from "./provider.js";

export function parseLyrics(lrc: string, tlyric?: string): LyricLine[] {
  if (!lrc) return [];

  const parseLine = (
    line: string
  ): { time: number; text: string } | null => {
    const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.+)$/);
    if (!match) return null;
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const ms = parseInt(match[3].padEnd(3, "0"), 10);
    const text = match[4].trim();

    if (/^(作词|作曲|编曲|制作|混音|母带)\s*[:：]/.test(text)) return null;

    return { time: minutes * 60 + seconds + ms / 1000, text };
  };

  const lines: LyricLine[] = [];
  const translationMap = new Map<number, string>();

  if (tlyric) {
    for (const line of tlyric.split("\n")) {
      const parsed = parseLine(line);
      if (parsed) {
        translationMap.set(Math.round(parsed.time * 100), parsed.text);
      }
    }
  }

  for (const line of lrc.split("\n")) {
    const parsed = parseLine(line);
    if (parsed) {
      const timeKey = Math.round(parsed.time * 100);
      lines.push({
        time: parsed.time,
        text: parsed.text,
        translation: translationMap.get(timeKey),
      });
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

// NetEase quality levels: standard(128k) higher(192k) exhigh(320k) lossless(flac) hires(hi-res) jyeffect jymaster
export const NETEASE_QUALITY_LEVELS = [
  { value: "standard", label: "标准 (128kbps)", bitrate: 128 },
  { value: "higher", label: "较高 (192kbps)", bitrate: 192 },
  { value: "exhigh", label: "极高 (320kbps)", bitrate: 320 },
  { value: "lossless", label: "无损 (FLAC)", bitrate: 900 },
  { value: "hires", label: "Hi-Res", bitrate: 1500 },
  { value: "jymaster", label: "超清母带", bitrate: 4000 },
] as const;

export class NeteaseProvider implements MusicProvider {
  readonly platform = "netease" as const;
  private api: AxiosInstance;
  private cookie = "";
  private quality = "exhigh";

  constructor(baseUrl: string) {
    this.api = axios.create({
      baseURL: baseUrl,
      timeout: 10000,
    });
  }

  setQuality(quality: string): void {
    this.quality = quality;
  }

  getQuality(): string {
    return this.quality;
  }

  private get cookieParams(): Record<string, string> {
    return this.cookie ? { cookie: this.cookie } : {};
  }

  async search(query: string, limit = 20): Promise<SearchResult> {
    const [songRes, playlistRes] = await Promise.all([
      this.api.get("/cloudsearch", {
        params: { keywords: query, type: 1, limit, ...this.cookieParams },
      }),
      this.api.get("/cloudsearch", {
        params: {
          keywords: query,
          type: 1000,
          limit: 5,
          ...this.cookieParams,
        },
      }),
    ]);

    const songs: Song[] = (songRes.data?.result?.songs ?? []).map(
      (s: any) => ({
        id: String(s.id),
        name: s.name,
        artist: (s.ar ?? []).map((a: any) => a.name).join(" / "),
        album: s.al?.name ?? "",
        duration: Math.round((s.dt ?? 0) / 1000),
        coverUrl: s.al?.picUrl ?? "",
        platform: "netease",
      })
    );

    const playlists: Playlist[] = (
      playlistRes.data?.result?.playlists ?? []
    ).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
    }));

    return { songs, playlists, albums: [] };
  }

  async getSongUrl(songId: string, quality?: string): Promise<string | null> {
    const level = quality ?? this.quality;
    const res = await this.api.get("/song/url/v1", {
      params: { id: songId, level, ...this.cookieParams },
    });
    return res.data?.data?.[0]?.url ?? null;
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    const res = await this.api.get("/song/detail", {
      params: { ids: songId, ...this.cookieParams },
    });
    const s = res.data?.songs?.[0];
    if (!s) return null;
    return {
      id: String(s.id),
      name: s.name,
      artist: (s.ar ?? []).map((a: any) => a.name).join(" / "),
      album: s.al?.name ?? "",
      duration: Math.round((s.dt ?? 0) / 1000),
      coverUrl: s.al?.picUrl ?? "",
      platform: "netease",
    };
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    const res = await this.api.get("/playlist/track/all", {
      params: { id: playlistId, ...this.cookieParams },
    });
    return (res.data?.songs ?? []).map((s: any) => ({
      id: String(s.id),
      name: s.name,
      artist: (s.ar ?? []).map((a: any) => a.name).join(" / "),
      album: s.al?.name ?? "",
      duration: Math.round((s.dt ?? 0) / 1000),
      coverUrl: s.al?.picUrl ?? "",
      platform: "netease",
    }));
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    const res = await this.api.get("/personalized", {
      params: { limit: 10, ...this.cookieParams },
    });
    return (res.data?.result ?? []).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.picUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
    }));
  }

  async getAlbumSongs(albumId: string): Promise<Song[]> {
    const res = await this.api.get("/album", {
      params: { id: albumId, ...this.cookieParams },
    });
    return (res.data?.songs ?? []).map((s: any) => ({
      id: String(s.id),
      name: s.name,
      artist: (s.ar ?? []).map((a: any) => a.name).join(" / "),
      album: s.al?.name ?? "",
      duration: Math.round((s.dt ?? 0) / 1000),
      coverUrl: s.al?.picUrl ?? "",
      platform: "netease",
    }));
  }

  async getLyrics(songId: string): Promise<LyricLine[]> {
    const res = await this.api.get("/lyric", {
      params: { id: songId, ...this.cookieParams },
    });
    return parseLyrics(
      res.data?.lrc?.lyric ?? "",
      res.data?.tlyric?.lyric
    );
  }

  async getQrCode(): Promise<QrCodeResult> {
    const keyRes = await this.api.get("/login/qr/key", {
      params: { timestamp: Date.now() },
    });
    const key = keyRes.data?.data?.unikey ?? "";
    const createRes = await this.api.get("/login/qr/create", {
      params: { key, qrimg: true },
    });
    return {
      qrUrl: createRes.data?.data?.qrurl ?? "",
      qrImg: createRes.data?.data?.qrimg ?? "",
      key,
    };
  }

  async checkQrCodeStatus(
    key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    const res = await this.api.get("/login/qr/check", {
      params: { key, timestamp: Date.now() },
    });
    const code = res.data?.code;
    switch (code) {
      case 801:
        return "waiting";
      case 802:
        return "scanned";
      case 803:
        if (res.data?.cookie) {
          this.cookie = res.data.cookie;
        }
        return "confirmed";
      default:
        return "expired";
    }
  }

  async sendSmsCode(phone: string): Promise<boolean> {
    const res = await this.api.get("/captcha/sent", {
      params: { phone },
    });
    return res.data?.code === 200;
  }

  async loginWithSms(phone: string, code: string): Promise<boolean> {
    const res = await this.api.get("/captcha/verify", {
      params: { phone, captcha: code },
    });
    if (res.data?.cookie) {
      this.cookie = res.data.cookie;
    }
    return res.data?.code === 200;
  }

  setCookie(cookie: string): void {
    this.cookie = cookie;
  }

  getCookie(): string {
    return this.cookie;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    if (!this.cookie) return { loggedIn: false };
    try {
      const res = await this.api.get("/login/status", {
        params: { ...this.cookieParams },
      });
      const profile = res.data?.data?.profile;
      if (profile) {
        return {
          loggedIn: true,
          nickname: profile.nickname,
          avatarUrl: profile.avatarUrl,
        };
      }
    } catch {
      // ignore
    }
    return { loggedIn: false };
  }

  async getPersonalFm(): Promise<Song[]> {
    const res = await this.api.get("/personal_fm", {
      params: { ...this.cookieParams },
    });
    return (res.data?.data ?? []).map((s: any) => ({
      id: String(s.id),
      name: s.name,
      artist: (s.artists ?? []).map((a: any) => a.name).join(" / "),
      album: s.album?.name ?? "",
      duration: Math.round((s.duration ?? 0) / 1000),
      coverUrl: s.album?.picUrl ?? "",
      platform: "netease",
    }));
  }

  async getDailyRecommendSongs(): Promise<Song[]> {
    const res = await this.api.get("/recommend/songs", {
      params: { ...this.cookieParams },
    });
    return (res.data?.data?.dailySongs ?? []).map((s: any) => ({
      id: String(s.id),
      name: s.name,
      artist: (s.ar ?? []).map((a: any) => a.name).join(" / "),
      album: s.al?.name ?? "",
      duration: Math.round((s.dt ?? 0) / 1000),
      coverUrl: s.al?.picUrl ?? "",
      platform: "netease",
    }));
  }

  async getPlaylistDetail(playlistId: string): Promise<PlaylistDetail | null> {
    const res = await this.api.get("/playlist/detail", {
      params: { id: playlistId, ...this.cookieParams },
    });
    const p = res.data?.playlist;
    if (!p) return null;
    return {
      id: String(p.id),
      name: p.name ?? "",
      description: p.description ?? "",
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
    };
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    // First get user ID from login status
    const statusRes = await this.api.get("/login/status", {
      params: { ...this.cookieParams },
    });
    const uid = statusRes.data?.data?.profile?.userId;
    if (!uid) return [];

    const res = await this.api.get("/user/playlist", {
      params: { uid, ...this.cookieParams },
    });
    return (res.data?.playlist ?? []).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
    }));
  }
}
