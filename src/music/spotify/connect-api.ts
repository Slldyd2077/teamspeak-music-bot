import axios, { type AxiosInstance } from "axios";

const API_BASE = "https://api.spotify.com";

export interface SpotifyDevice {
  id: string;
  name: string;
  is_active: boolean;
}

export interface PlaybackState {
  isPlaying: boolean;
  progressMs: number;
  trackUri: string | null;
  durationMs: number;
}

/**
 * Spotify Web API "Connect" remote-control client. Wraps an axios instance and
 * attaches a live user Bearer token from getToken() to every request.
 *
 * Error policy:
 * - Read-only calls (getDevices/getPlaybackState) degrade to []/null on error.
 * - Mutating calls (transfer/play/pause/resume/seek) no-op when unauthorized.
 * - REQUIRED CORRECTION C3.6: mutating calls ALSO swallow transport errors
 *   (403 non-Premium / 404 no active device / 429 rate-limited / network) and
 *   resolve to void instead of rejecting. The contract keeps the Promise<void>
 *   signatures, so the backend treats a failed play as "couldn't play" and
 *   falls back — a transient Spotify error can never surface as an unhandled
 *   rejection that crashes the queue-advance path.
 */
export class SpotifyConnectApi {
  private getToken: () => Promise<string | null>;
  private http: AxiosInstance;

  constructor(getToken: () => Promise<string | null>, deps?: { http?: AxiosInstance }) {
    this.getToken = getToken;
    this.http = deps?.http ?? axios.create({ baseURL: API_BASE, timeout: 15_000 });
  }

  /** Bearer auth headers, or null when no valid user token is available. */
  private async authHeaders(): Promise<{ Authorization: string } | null> {
    const token = await this.getToken();
    if (!token) return null;
    return { Authorization: `Bearer ${token}` };
  }

  async getDevices(): Promise<SpotifyDevice[]> {
    const headers = await this.authHeaders();
    if (!headers) return [];
    try {
      const { data } = await this.http.get("/v1/me/player/devices", { headers });
      const list = Array.isArray(data?.devices) ? data.devices : [];
      return list.map((d: any) => ({
        id: d?.id ?? "",
        name: d?.name ?? "",
        is_active: Boolean(d?.is_active),
      }));
    } catch {
      return [];
    }
  }

  async findDeviceByName(name: string): Promise<string | null> {
    const devices = await this.getDevices();
    const match = devices.find((d) => d.name === name);
    return match ? match.id : null;
  }

  async transfer(deviceId: string, play = false): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    try {
      await this.http.put("/v1/me/player", { device_ids: [deviceId], play }, { headers });
    } catch {
      // C3.6: swallow (e.g. 403/404/429) — never reject up the queue path.
    }
  }

  async play(deviceId: string, trackUri: string): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    try {
      await this.http.put(
        "/v1/me/player/play",
        { uris: [trackUri] },
        { headers, params: { device_id: deviceId } },
      );
    } catch {
      // C3.6: swallow — the backend treats a failed play as "couldn't play".
    }
  }

  async pause(deviceId?: string): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    try {
      await this.http.put("/v1/me/player/pause", undefined, {
        headers,
        params: deviceId ? { device_id: deviceId } : undefined,
      });
    } catch {
      // C3.6: swallow.
    }
  }

  async resume(deviceId?: string): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    try {
      await this.http.put("/v1/me/player/play", undefined, {
        headers,
        params: deviceId ? { device_id: deviceId } : undefined,
      });
    } catch {
      // C3.6: swallow.
    }
  }

  async seek(ms: number, deviceId?: string): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    const params: Record<string, unknown> = { position_ms: ms };
    if (deviceId) params.device_id = deviceId;
    try {
      await this.http.put("/v1/me/player/seek", undefined, { headers, params });
    } catch {
      // C3.6: swallow.
    }
  }

  async getPlaybackState(): Promise<PlaybackState | null> {
    const headers = await this.authHeaders();
    if (!headers) return null;
    try {
      const res = await this.http.get("/v1/me/player", { headers });
      // 204 = no active device / playback; body is empty.
      if (res.status === 204 || !res.data) return null;
      const d = res.data;
      return {
        isPlaying: Boolean(d.is_playing),
        progressMs: Number(d.progress_ms ?? 0),
        trackUri: d.item?.uri ?? null,
        durationMs: Number(d.item?.duration_ms ?? 0),
      };
    } catch {
      return null;
    }
  }
}
