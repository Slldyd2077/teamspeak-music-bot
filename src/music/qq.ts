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
  Album,
} from "./provider.js";
import { parseLyrics } from "./netease.js";

// Primary search client: u.y.qq.com/cgi-bin/musicu.fcg (JSON sub-request
// batch). Was broken ca. 2026-05 due to two upstream API changes:
//   1. searchid param must NOT be present (causes all lists to be empty)
//   2. num_per_page must be >= 10 (lower values return empty)
// Both fixes applied per https://github.com/ZHANGTIANYAO1/teamspeak-music-bot/issues/61
const qqMusicuApi = axios.create({
  baseURL: "https://u.y.qq.com",
  timeout: 10000,
  headers: { referer: "https://y.qq.com" },
});

// Fallback search client: c.y.qq.com/soso/fcgi-bin/client_search_cp (classic
// endpoint, song + album only, no playlist support).
const qqSearchApi = axios.create({
  baseURL: "https://c.y.qq.com",
  timeout: 10000,
  headers: { referer: "https://y.qq.com" },
});

// Direct client for c.y.qq.com endpoints (collected playlists / favorites).
// The bundled qq-music-api wrapper doesn't expose these endpoints.
const qqFavApi = axios.create({
  baseURL: "https://c.y.qq.com",
  timeout: 10000,
  headers: { referer: "https://y.qq.com/" },
});

export function mapQqAlbums(raw: any[] | null | undefined): Album[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => {
    const id = String(a.albumMID ?? a.mid ?? a.albumID ?? "");
    const artist = a.singerName
      ?? (Array.isArray(a.singer) ? a.singer.map((s: any) => s.name).join(" / ") : "");
    const coverUrl = id
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${id}.jpg`
      : (a.albumPic ?? "");
    return {
      id,
      name: a.albumName ?? a.title ?? "",
      artist,
      coverUrl,
      songCount: a.song_count ?? a.songCount ?? 0,
      platform: "qq" as const,
    };
  });
}

function computeGtk(pSkey: string): number {
  let hash = 5381;
  for (let i = 0; i < pSkey.length; i++) {
    hash = (hash + (hash << 5) + pSkey.charCodeAt(i)) | 0;
  }
  return hash & 0x7fffffff;
}

export class QQMusicProvider implements MusicProvider {
  readonly platform = "qq" as const;
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
    // Primary: u.y.qq.com/cgi-bin/musicu.fcg — supports songs + albums +
    // playlists. Fixed per https://github.com/ZHANGTIANYAO1/teamspeak-music-bot/issues/61
    // (removed searchid, num_per_page >= 10, corrected search_type values).
    const primary = await this.searchViaMusicuFcg(query, limit);
    if (primary) return primary;

    // Fallback: c.y.qq.com/soso/fcgi-bin/client_search_cp (song + album,
    // no playlist support). Kept as redundancy.
    return this.searchViaClientSearchCp(query, limit);
  }

  /** Primary search via u.y.qq.com/cgi-bin/musicu.fcg.
   *
   * Two upstream API changes (2026-05) required fixes:
   *   1. Omit `searchid` — its presence now causes all lists to be empty.
   *   2. `num_per_page` >= 10 — lower values return empty.
   *   3. `search_type: 2` for albums, `3` for playlists (8 was "user"). */
  private async searchViaMusicuFcg(
    query: string,
    limit: number
  ): Promise<SearchResult | null> {
    try {
      const numPerPage = Math.max(10, Math.min(limit, 50));
      const reqData = JSON.stringify({
        req_0: {
          module: "music.search.SearchCgiService",
          method: "DoSearchForQQMusicDesktop",
          param: { query, num_per_page: numPerPage, search_type: 0 },
        },
        req_album: {
          module: "music.search.SearchCgiService",
          method: "DoSearchForQQMusicDesktop",
          param: { query, num_per_page: 10, search_type: 2 },
        },
        req_playlist: {
          module: "music.search.SearchCgiService",
          method: "DoSearchForQQMusicDesktop",
          param: { query, num_per_page: 10, search_type: 3 },
        },
      });
      const res = await qqMusicuApi.get("/cgi-bin/musicu.fcg", {
        params: { format: "json", data: reqData },
      });

      const songList: any[] =
        res.data?.req_0?.data?.body?.song?.list ?? [];
      if (songList.length === 0) return null;

      const songs: Song[] = songList.map((s: any) => ({
        id: String(s.mid ?? s.id),
        name: s.title ?? s.name ?? "",
        artist: (s.singer ?? []).map((a: any) => a.name).join(" / "),
        album: s.album?.name ?? s.album?.title ?? "",
        duration: s.interval ?? 0,
        coverUrl: s.album?.mid
          ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.album.mid}.jpg`
          : "",
        platform: "qq",
      }));

      const albumList: any[] = res.data?.req_album?.data?.body?.album?.list ?? [];
      const albums = mapQqAlbums(albumList);

      const playlistList: any[] = res.data?.req_playlist?.data?.body?.songlist?.list ?? [];
      const playlists: Playlist[] = playlistList.map((p: any) => ({
        id: String(p.dissid ?? p.id ?? ""),
        name: p.dissname ?? p.title ?? "",
        coverUrl: p.imgurl ?? p.logo ?? "",
        songCount: p.songnum ?? p.song_count ?? 0,
        platform: "qq" as const,
      }));

      return { songs, playlists, albums };
    } catch {
      return null;
    }
  }

  /** Fallback search via c.y.qq.com/soso/fcgi-bin/client_search_cp */
  private async searchViaClientSearchCp(
    query: string,
    limit: number
  ): Promise<SearchResult> {
    const songParams = {
      w: query,
      format: "json",
      p: 1,
      n: Math.min(limit, 50),
      type: 0,
      cr: 1,
    };
    const albumParams = {
      w: query,
      format: "json",
      p: 1,
      n: 5,
      t: 8,
      cr: 1,
    };

    const [songRes, albumRes] = await Promise.allSettled([
      qqSearchApi.get("/soso/fcgi-bin/client_search_cp", { params: songParams }),
      qqSearchApi.get("/soso/fcgi-bin/client_search_cp", { params: albumParams }),
    ]);

    const songList: any[] =
      songRes.status === "fulfilled"
        ? (songRes.value.data?.data?.song?.list ?? [])
        : [];

    const songs: Song[] = songList.map((s: any) => ({
      id: String(s.songmid ?? s.songid ?? ""),
      name: s.songname ?? s.name ?? "",
      artist: (s.singer ?? []).map((a: any) => a.name).join(" / "),
      album: s.albumname ?? s.album?.name ?? "",
      duration: s.interval ?? 0,
      coverUrl: s.albummid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg`
        : "",
      platform: "qq",
    }));

    const albumList: any[] =
      albumRes.status === "fulfilled"
        ? (albumRes.value.data?.data?.album?.list ?? [])
        : [];
    const albums = mapQqAlbums(albumList);

    return { songs, playlists: [], albums };
  }

  async getSongUrl(songId: string, quality?: string): Promise<string | null> {
    try {
      const res = await this.api.get("/getMusicPlay", {
        params: { songmid: songId, quality: quality ?? this.quality, ...this.cookieParams },
      });
      const playUrl = res.data?.data?.playUrl?.[songId];
      if (playUrl?.url) return playUrl.url;
    } catch {
      // try with songid
      try {
        const res = await this.api.get("/getMusicPlay", {
          params: { songid: songId, quality: quality ?? this.quality, ...this.cookieParams },
        });
        const playUrl = res.data?.data?.playUrl?.[songId];
        if (playUrl?.url) return playUrl.url;
      } catch {
        // ignore
      }
    }
    return null;
  }

  /**
   * Batch-check which song mids are actually streamable. QQ playlists
   * (especially collected ones) frequently contain a majority of songs
   * that return result=104003 ("no copyright/region restricted") for the
   * current user — a sequential retry loop wastes time guessing.
   *
   * The wrapper's /getMusicPlay accepts a comma-separated songmid list
   * and resolves all of them in a single upstream call. We chunk to keep
   * the URL well under typical 8KB query-string limits and to keep per-
   * request latency bounded (~2-3s per 100 mids).
   *
   * Returns:
   *   - non-null Set: authoritative result. Empty Set means all songs are
   *     unplayable; non-empty means filter to those mids.
   *   - null: every chunk failed. Caller should fall back to sequential
   *     retry rather than treating as "all unplayable".
   */
  async getPlayableSongIds(songIds: string[]): Promise<Set<string> | null> {
    if (songIds.length === 0) return new Set();

    const CHUNK = 100;          // ~14 chars/mid * 100 + commas ≈ 1.5KB
    const playable = new Set<string>();
    let allChunksFailed = true;
    for (let i = 0; i < songIds.length; i += CHUNK) {
      const slice = songIds.slice(i, i + CHUNK);
      try {
        const res = await this.api.get("/getMusicPlay", {
          params: { songmid: slice.join(","), quality: this.quality, ...this.cookieParams },
        });
        const playUrlMap: Record<string, { url?: string }> | undefined =
          res.data?.data?.playUrl;
        if (!playUrlMap) continue; // chunk-level failure, try next
        allChunksFailed = false;
        for (const [mid, info] of Object.entries(playUrlMap)) {
          if (info?.url) playable.add(mid);
        }
      } catch {
        // chunk-level failure — keep going so a transient error on one
        // chunk doesn't poison the whole batch.
      }
    }
    return allChunksFailed ? null : playable;
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    // Try /getSongInfo for full metadata, but fall through to a minimal
    // stub if the library endpoint fails (current @sansenjian/qq-music-api
    // returns upstream code 500001 for this route — the param format it
    // sends doesn't match QQ's current API). The bot's resolveAndPlay path
    // only needs `id` and `platform` to fetch a play URL, and the fallback
    // stub is sufficient to let /play-by-id and /add-by-id flows succeed.
    try {
      const res = await this.api.get("/getSongInfo", {
        params: { songmid: songId, ...this.cookieParams },
      });
      const s = res.data?.response?.data;
      if (s && s.track_info) {
        const t = s.track_info;
        return {
          id: String(t.mid ?? t.id),
          name: t.name ?? "",
          artist: (t.singer ?? []).map((a: any) => a.name).join(" / "),
          album: t.album?.name ?? "",
          duration: t.interval ?? 0,
          coverUrl: t.album?.mid
            ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${t.album.mid}.jpg`
            : "",
          platform: "qq",
        };
      }
    } catch {
      // fall through to stub
    }
    // Minimal stub — resolveAndPlay only needs id + platform to fetch a
    // play URL. Name/artist/album will be empty in play history, but the
    // song will actually play, which is the important part.
    return {
      id: songId,
      name: "",
      artist: "",
      album: "",
      duration: 0,
      coverUrl: "",
      platform: "qq",
    };
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    const res = await this.api.get("/getSongListDetail", {
      params: { disstid: playlistId, ...this.cookieParams },
    });
    const cdlist = res.data?.response?.cdlist ?? [];
    if (cdlist.length === 0) return [];
    return (cdlist[0].songlist ?? []).map((s: any) => ({
      id: String(s.mid ?? s.songmid ?? s.songid),
      name: s.songname ?? s.name ?? "",
      artist: (s.singer ?? []).map((a: any) => a.name).join(" / "),
      album: s.albumname ?? "",
      duration: s.interval ?? 0,
      coverUrl: s.album?.mid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.album.mid}.jpg`
        : s.albummid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg`
        : "",
      platform: "qq",
    }));
  }

  async getPlaylistDetail(playlistId: string): Promise<PlaylistDetail | null> {
    const res = await this.api.get("/getSongListDetail", {
      params: { disstid: playlistId, ...this.cookieParams },
    });
    const cd = res.data?.response?.cdlist?.[0];
    if (!cd) return null;
    return {
      id: String(cd.disstid ?? cd.dissid ?? ""),
      name: cd.dissname ?? "",
      description: cd.desc ?? "",
      coverUrl: cd.logo ?? "",
      songCount: cd.songnum ?? cd.total_song_num ?? 0,
    };
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    const res = await this.api.get("/getSongLists", {
      params: { categoryId: 10000000, pageSize: 10, ...this.cookieParams },
    });
    return (res.data?.response?.data?.list ?? []).map((p: any) => ({
      id: String(p.dissid),
      name: p.dissname ?? "",
      coverUrl: p.imgurl ?? "",
      songCount: p.listennum ?? 0,
      platform: "qq",
    }));
  }

  async getAlbumSongs(albumId: string): Promise<Song[]> {
    const res = await this.api.get("/getAlbumInfo", {
      params: { albummid: albumId, ...this.cookieParams },
    });
    return (res.data?.response?.data?.list ?? []).map((s: any) => ({
      id: String(s.songmid ?? s.songid),
      name: s.songname ?? "",
      artist: (s.singer ?? []).map((a: any) => a.name).join(" / "),
      album: s.albumname ?? "",
      duration: s.interval ?? 0,
      coverUrl: s.albummid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg`
        : "",
      platform: "qq",
    }));
  }

  async getLyrics(songId: string): Promise<LyricLine[]> {
    const res = await this.api.get("/getLyric", {
      params: { songmid: songId, ...this.cookieParams },
    });
    return parseLyrics(
      res.data?.response?.lyric ?? res.data?.lyric ?? "",
      res.data?.response?.trans ?? res.data?.trans ?? ""
    );
  }

  async getQrCode(): Promise<QrCodeResult> {
    // @sansenjian/qq-music-api 2.x returns { img, qrsig, ptqrtoken } via
    // customResponse (no { response: ... } wrapping). /checkQQLoginQr
    // requires BOTH qrsig AND ptqrtoken — passing only one gives a 400
    // "参数错误". Pack both into the opaque `key` field so the polling
    // endpoint can split them back out. Separator "|" is safe: QQ tokens
    // are alphanumeric.
    const res = await this.api.get("/getQQLoginQr");
    const qrsig: string = res.data?.qrsig ?? "";
    const ptqrtoken: string = String(res.data?.ptqrtoken ?? "");
    return {
      qrUrl: "",
      qrImg: res.data?.img ?? "",
      key: `${qrsig}|${ptqrtoken}`,
    };
  }

  async checkQrCodeStatus(
    key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    const [qrsig, ptqrtoken] = key.split("|");
    if (!qrsig || !ptqrtoken) return "expired";

    // NOTE: /checkQQLoginQr is registered as POST only in
    // @sansenjian/qq-music-api 2.x. GET returns 405 Method Not Allowed.
    let res;
    try {
      res = await this.api.post("/checkQQLoginQr", null, {
        params: { qrsig, ptqrtoken },
      });
    } catch {
      return "expired";
    }

    // customResponse shape:
    //   success:  { isOk: true, message: '登录成功', session: { cookie, ... } }
    //   scanning: { isOk: false, refresh: false, message: '未扫描二维码' }
    //   expired:  { isOk: false, refresh: true,  message: '二维码已失效' }
    const body = res.data;
    if (body?.isOk === true) {
      const cookie: string = body.session?.cookie ?? "";
      if (cookie) this.cookie = cookie;
      return "confirmed";
    }
    if (body?.refresh === true) return "expired";
    if (typeof body?.message === "string" && body.message.includes("未扫描"))
      return "waiting";
    return "waiting";
  }

  setCookie(cookie: string): void {
    this.cookie = cookie;
  }

  getCookie(): string {
    return this.cookie;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    if (!this.cookie) return { loggedIn: false };
    // /getUserAvatar in @sansenjian/qq-music-api 2.x is NOT registered on
    // the main router; the real endpoint is /user/getUserAvatar, and even
    // that just builds a static URL from a uin without validating the
    // cookie against QQ. Round-trip through /user/getUserPlaylists which
    // actually hits QQ Music with the cookie; if the upstream returns
    // code=0, the cookie is valid.
    //
    // IMPORTANT: /user/getUserPlaylists requires `uin` as a query param —
    // the library 400s with "缺少 uin 参数" otherwise. Parse it out of the
    // cookie (uin=<qq>; comes after the various *uin prefixed names, which
    // is why the regex anchors on a word boundary).
    const uinMatch = /(?:^|; )uin=o?0?(\d+)/.exec(this.cookie);
    const uin = uinMatch ? uinMatch[1] : "";
    if (!uin) return { loggedIn: false };
    try {
      const res = await this.api.get("/user/getUserPlaylists", {
        params: { uin, ...this.cookieParams },
      });
      if (res.data?.response?.code !== 0) return { loggedIn: false };
      return {
        loggedIn: true,
        nickname: `QQ ${uin}`,
        avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${uin}&spec=100`,
      };
    } catch {
      return { loggedIn: false };
    }
  }

  async getDailyRecommendSongs(): Promise<Song[]> {
    // QQ has no per-user daily list; use newsong.NewSongServer (新歌速递)
    // as the closest analogue. Returns ~20 newly-released songs.
    try {
      const res = await this.api.get("/getNewSongs", {
        params: { ...this.cookieParams },
      });
      const list: any[] = res.data?.response?.new_song?.data?.songlist ?? [];
      return list.map((s: any) => ({
        id: String(s.mid ?? s.id),
        name: s.title ?? s.name ?? "",
        artist: (s.singer ?? []).map((a: any) => a.name).join(" / "),
        album: s.album?.name ?? s.album?.title ?? "",
        duration: s.interval ?? 0,
        coverUrl: s.album?.mid
          ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.album.mid}.jpg`
          : "",
        platform: "qq",
      }));
    } catch {
      return [];
    }
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    if (!this.cookie) return [];
    const uinMatch = /(?:^|; )uin=o?0?(\d+)/.exec(this.cookie);
    const uin = uinMatch ? uinMatch[1] : "";
    if (!uin) return [];

    // Created and collected playlists come from two separate QQ endpoints.
    // Run them in parallel and concatenate (created first, then collected),
    // matching the order shown in the QQ Music desktop app.
    const [created, collected] = await Promise.all([
      this.fetchCreatedPlaylists(uin),
      this.fetchCollectedPlaylists(uin),
    ]);
    return [...created, ...collected];
  }

  private async fetchCreatedPlaylists(uin: string): Promise<Playlist[]> {
    try {
      const res = await this.api.get("/user/getUserPlaylists", {
        params: { uin, ...this.cookieParams },
      });
      if (res.data?.response?.code !== 0) return [];
      return (res.data?.response?.data?.playlists ?? []).map((p: any) => {
        // fcg_get_profile_homepage returns title/picurl/subtitle ("X首  Y次播放").
        const subtitle: string = p.subtitle ?? "";
        const songCountFromSubtitle = parseInt(subtitle.match(/(\d+)\s*首/)?.[1] ?? "0", 10);
        return {
          id: String(p.dissid ?? p.id ?? ""),
          name: p.title ?? p.dissname ?? p.name ?? "",
          coverUrl: p.picurl ?? p.imgurl ?? p.coverUrl ?? "",
          songCount: p.song_count ?? p.listennum ?? songCountFromSubtitle,
          platform: "qq",
        };
      });
    } catch {
      return [];
    }
  }

  private async fetchCollectedPlaylists(uin: string): Promise<Playlist[]> {
    // c.y.qq.com fav endpoint: reqtype=3 returns collected playlists (cdlist).
    // Requires g_tk derived from the p_skey cookie.
    const pSkeyMatch = /(?:^|; )p_skey=([^;]+)/.exec(this.cookie);
    if (!pSkeyMatch) return [];
    const gtk = computeGtk(pSkeyMatch[1]);

    const PAGE_SIZE = 30;
    const MAX_PAGES = 10;       // 300-playlist hard cap; should cover any sane user
    const all: Playlist[] = [];
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const sin = page * PAGE_SIZE;
        const ein = sin + PAGE_SIZE - 1;
        const res = await qqFavApi.get("/fav/fcgi-bin/fcg_get_profile_order_asset.fcg", {
          params: {
            ct: 20,
            cid: 205360956,
            userid: uin,
            reqtype: 3,
            sin,
            ein,
            g_tk: gtk,
            format: "json",
          },
          headers: { Cookie: this.cookie },
        });
        if (res.data?.code !== 0) break;
        const list: any[] = res.data?.data?.cdlist ?? [];
        for (const p of list) {
          all.push({
            id: String(p.dissid ?? ""),
            name: p.dissname ?? "",
            coverUrl: p.logo ?? "",
            songCount: p.songnum ?? 0,
            platform: "qq",
          });
        }
        // Stop when upstream signals no more pages, or when this page is
        // short (also indicates end). has_more is the canonical signal.
        const hasMore = res.data?.data?.has_more === 1 || res.data?.data?.has_more === true;
        if (!hasMore || list.length < PAGE_SIZE) break;
      }
    } catch {
      // Return whatever we got so far on partial failure rather than dropping
      // earlier pages.
    }
    return all;
  }
}
