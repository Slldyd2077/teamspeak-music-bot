import axios, { type AxiosInstance } from "axios";

const API_BASE = "https://api.spotify.com";

/**
 * Task S4.6 (spec §4.3/§13 recovery/watchdog): transient Connect-command
 * failures that warrant a bounded retry with exponential backoff. 404 is the
 * device-visibility latency case (device not yet enumerated), 429 is rate-limit,
 * 5xx are Spotify-side flakiness. Everything else (401/403/network) is NOT
 * retried — it is swallowed immediately (C3.6).
 */
const TRANSIENT = new Set([404, 429, 500, 502, 503]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 150;
const MAX_DELAY_MS = 2_000;

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
  private sleep: (ms: number) => Promise<void>;
  private logger?: import("pino").Logger;

  constructor(
    getToken: () => Promise<string | null>,
    deps?: {
      http?: AxiosInstance;
      sleep?: (ms: number) => Promise<void>;
      logger?: import("pino").Logger;
    },
  ) {
    this.getToken = getToken;
    this.http = deps?.http ?? axios.create({ baseURL: API_BASE, timeout: 15_000 });
    this.sleep = deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logger = deps?.logger;
  }

  /** Bearer auth headers, or null when no valid user token is available. */
  private async authHeaders(): Promise<{ Authorization: string } | null> {
    const token = await this.getToken();
    if (!token) return null;
    return { Authorization: `Bearer ${token}` };
  }

  /**
   * S4.6 recovery/watchdog: run a mutating PUT with bounded retry + exponential
   * backoff on TRANSIENT statuses only. On exhaustion OR a non-transient error
   * it SWALLOWS and warns once — preserving C3.6 (a mutating command NEVER
   * rejects up the queue-advance path). Tokens are never logged.
   */
  private async mutateWithRetry(put: () => Promise<unknown>): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await put();
        return;
      } catch (err: any) {
        const status = err?.response?.status;
        if (!TRANSIENT.has(status) || attempt === MAX_ATTEMPTS) {
          // C3.6: never reject up the queue path — swallow, but surface once.
          this.logger?.warn(
            { status },
            "Spotify Connect command failed (exhausted/non-retryable)",
          );
          return;
        }
        let delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
        if (status === 429) {
          const ra = Number(err?.response?.headers?.["retry-after"]);
          if (Number.isFinite(ra) && ra > 0) delay = Math.min(ra * 1000, MAX_DELAY_MS);
        }
        await this.sleep(delay);
      }
    }
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
    await this.mutateWithRetry(() =>
      this.http.put("/v1/me/player", { device_ids: [deviceId], play }, { headers }),
    );
  }

  async play(deviceId: string, trackUri: string): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    await this.mutateWithRetry(() =>
      this.http.put(
        "/v1/me/player/play",
        { uris: [trackUri] },
        { headers, params: { device_id: deviceId } },
      ),
    );
  }

  async pause(deviceId?: string): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    await this.mutateWithRetry(() =>
      this.http.put("/v1/me/player/pause", undefined, {
        headers,
        params: deviceId ? { device_id: deviceId } : undefined,
      }),
    );
  }

  async resume(deviceId?: string): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    await this.mutateWithRetry(() =>
      this.http.put("/v1/me/player/play", undefined, {
        headers,
        params: deviceId ? { device_id: deviceId } : undefined,
      }),
    );
  }

  async seek(ms: number, deviceId?: string): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) return;
    const params: Record<string, unknown> = { position_ms: ms };
    if (deviceId) params.device_id = deviceId;
    await this.mutateWithRetry(() =>
      this.http.put("/v1/me/player/seek", undefined, { headers, params }),
    );
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
