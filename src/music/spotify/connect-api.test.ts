import { describe, it, expect, vi } from "vitest";
import type { AxiosInstance } from "axios";
import { SpotifyConnectApi } from "./connect-api.js";

/** Minimal axios stub: only get/put are exercised by the Connect client. */
function makeHttp(overrides?: Partial<Record<"get" | "put", any>>) {
  return {
    get: vi.fn().mockResolvedValue({ status: 200, data: {} }),
    put: vi.fn().mockResolvedValue({ status: 200, data: {} }),
    ...overrides,
  } as unknown as AxiosInstance;
}

const AUTH = { headers: { Authorization: "Bearer tok123" } };
const token = () =>
  vi.fn<() => Promise<string | null>>().mockResolvedValue("tok123");

describe("SpotifyConnectApi.getDevices", () => {
  it("GETs /v1/me/player/devices with the bearer header and maps the list", async () => {
    const http = makeHttp({
      get: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          devices: [
            { id: "dev-1", name: "TS Bot", is_active: true, type: "Speaker" },
            { id: "dev-2", name: "Phone", is_active: false },
          ],
        },
      }),
    });
    const api = new SpotifyConnectApi(token(), { http });
    const devices = await api.getDevices();
    expect(http.get).toHaveBeenCalledWith("/v1/me/player/devices", AUTH);
    expect(devices).toEqual([
      { id: "dev-1", name: "TS Bot", is_active: true },
      { id: "dev-2", name: "Phone", is_active: false },
    ]);
  });

  it("returns [] when getToken() is null (unauthorized) without calling http", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(vi.fn().mockResolvedValue(null), { http });
    await expect(api.getDevices()).resolves.toEqual([]);
    expect(http.get).not.toHaveBeenCalled();
  });

  it("returns [] on a 401/network rejection (graceful)", async () => {
    const err: any = new Error("unauthorized");
    err.response = { status: 401 };
    const http = makeHttp({ get: vi.fn().mockRejectedValue(err) });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.getDevices()).resolves.toEqual([]);
  });
});

describe("SpotifyConnectApi.findDeviceByName", () => {
  it("returns the matching device id", async () => {
    const http = makeHttp({
      get: vi.fn().mockResolvedValue({
        status: 200,
        data: { devices: [{ id: "dev-1", name: "TS Bot", is_active: false }] },
      }),
    });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.findDeviceByName("TS Bot")).resolves.toBe("dev-1");
  });

  it("returns null when no device name matches", async () => {
    const http = makeHttp({
      get: vi.fn().mockResolvedValue({
        status: 200,
        data: { devices: [{ id: "dev-1", name: "Other", is_active: false }] },
      }),
    });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.findDeviceByName("TS Bot")).resolves.toBeNull();
  });
});

describe("SpotifyConnectApi mutating calls", () => {
  it("transfer() PUTs /v1/me/player with device_ids + play=false default", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.transfer("dev-1");
    expect(http.put).toHaveBeenCalledWith(
      "/v1/me/player",
      { device_ids: ["dev-1"], play: false },
      AUTH,
    );
  });

  it("transfer(id, true) forwards play=true", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.transfer("dev-1", true);
    expect(http.put).toHaveBeenCalledWith(
      "/v1/me/player",
      { device_ids: ["dev-1"], play: true },
      AUTH,
    );
  });

  it("play() PUTs /v1/me/player/play?device_id= with the uris body", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.play("dev-1", "spotify:track:abc");
    expect(http.put).toHaveBeenCalledWith(
      "/v1/me/player/play",
      { uris: ["spotify:track:abc"] },
      { headers: { Authorization: "Bearer tok123" }, params: { device_id: "dev-1" } },
    );
  });

  it("pause() PUTs /v1/me/player/pause (no params) with no body", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.pause();
    expect(http.put).toHaveBeenCalledWith("/v1/me/player/pause", undefined, {
      headers: { Authorization: "Bearer tok123" },
      params: undefined,
    });
  });

  it("pause(id) forwards device_id param", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.pause("dev-1");
    expect(http.put).toHaveBeenCalledWith("/v1/me/player/pause", undefined, {
      headers: { Authorization: "Bearer tok123" },
      params: { device_id: "dev-1" },
    });
  });

  it("resume() PUTs /v1/me/player/play with no uris body (resume)", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.resume();
    expect(http.put).toHaveBeenCalledWith("/v1/me/player/play", undefined, {
      headers: { Authorization: "Bearer tok123" },
      params: undefined,
    });
  });

  it("resume(id) forwards device_id param", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.resume("dev-1");
    expect(http.put).toHaveBeenCalledWith("/v1/me/player/play", undefined, {
      headers: { Authorization: "Bearer tok123" },
      params: { device_id: "dev-1" },
    });
  });

  it("seek() PUTs /v1/me/player/seek?position_ms=", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.seek(42000);
    expect(http.put).toHaveBeenCalledWith("/v1/me/player/seek", undefined, {
      headers: { Authorization: "Bearer tok123" },
      params: { position_ms: 42000 },
    });
  });

  it("seek(ms, id) adds device_id param", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(token(), { http });
    await api.seek(1000, "dev-1");
    expect(http.put).toHaveBeenCalledWith("/v1/me/player/seek", undefined, {
      headers: { Authorization: "Bearer tok123" },
      params: { position_ms: 1000, device_id: "dev-1" },
    });
  });

  it("mutating calls no-op (no http.put) when unauthorized", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(vi.fn().mockResolvedValue(null), { http });
    await api.transfer("dev-1");
    await api.play("dev-1", "spotify:track:x");
    await api.pause();
    expect(http.put).not.toHaveBeenCalled();
  });
});

/**
 * REQUIRED CORRECTION C3.6: mutating calls must NOT reject up the queue-advance
 * path. A transient 403 (non-Premium) / 404 (no active device) / 429
 * (rate-limited) from Spotify must be swallowed (resolve to void), never thrown,
 * so a failed play() degrades to "couldn't play" instead of an unhandled
 * rejection that crashes the backend.
 */
describe("SpotifyConnectApi C3.6 — mutating calls are resilient (no throw)", () => {
  // S4.6: transient statuses (404/429) now retry with backoff; inject a no-op
  // sleep so these swallow-guarantee tests stay instant (no real timers). The
  // no-throw/swallow contract asserted here is unchanged.
  const noSleep = async () => {};

  function rejectingHttp(status: number) {
    const err: any = new Error(`http ${status}`);
    err.response = { status };
    return makeHttp({ put: vi.fn().mockRejectedValue(err) });
  }

  it("play() does NOT throw on a 404 (no active device)", async () => {
    const api = new SpotifyConnectApi(token(), {
      http: rejectingHttp(404),
      sleep: noSleep,
    });
    await expect(api.play("dev-1", "spotify:track:abc")).resolves.toBeUndefined();
  });

  it("play() does NOT throw on a 429 (rate-limited)", async () => {
    const api = new SpotifyConnectApi(token(), {
      http: rejectingHttp(429),
      sleep: noSleep,
    });
    await expect(api.play("dev-1", "spotify:track:abc")).resolves.toBeUndefined();
  });

  it("transfer() does NOT throw on a 403 (non-Premium)", async () => {
    const api = new SpotifyConnectApi(token(), { http: rejectingHttp(403) });
    await expect(api.transfer("dev-1", true)).resolves.toBeUndefined();
  });

  it("pause/resume/seek do NOT throw on a rejection", async () => {
    const api = new SpotifyConnectApi(token(), {
      http: rejectingHttp(404),
      sleep: noSleep,
    });
    await expect(api.pause("dev-1")).resolves.toBeUndefined();
    await expect(api.resume("dev-1")).resolves.toBeUndefined();
    await expect(api.seek(1000, "dev-1")).resolves.toBeUndefined();
  });

  it("play() does NOT throw on a raw network error (no response)", async () => {
    const http = makeHttp({ put: vi.fn().mockRejectedValue(new Error("ECONNRESET")) });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.play("dev-1", "spotify:track:abc")).resolves.toBeUndefined();
  });
});

/**
 * Task S4.6: bounded retry/backoff on the mutating Connect commands
 * (spec §4.3/§13 recovery/watchdog). Transient statuses {404,429,500,502,503}
 * retry up to MAX_ATTEMPTS (3) with exponential backoff; non-transient statuses
 * are NOT retried. Every path still preserves C3.6 (swallow, never throw). A
 * no-op injected `sleep` keeps the tests instant (no real timers).
 */
describe("SpotifyConnectApi S4.6 — retry/backoff on mutating commands", () => {
  const MAX_ATTEMPTS = 3;
  const noSleep = async () => {};

  function rejectStatus(status: number, headers?: Record<string, string>) {
    const err: any = new Error(`http ${status}`);
    err.response = { status, headers };
    return err;
  }

  it("play() retries a transient 404 then succeeds (2 calls, no throw)", async () => {
    const put = vi
      .fn()
      .mockRejectedValueOnce(rejectStatus(404))
      .mockResolvedValueOnce({ status: 200, data: {} });
    const http = makeHttp({ put });
    const api = new SpotifyConnectApi(token(), { http, sleep: noSleep });
    await expect(api.play("dev-1", "spotify:track:abc")).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("play() exhausts on a persistent 500 (MAX_ATTEMPTS calls, swallowed, warns once)", async () => {
    const put = vi.fn().mockRejectedValue(rejectStatus(500));
    const http = makeHttp({ put });
    const warn = vi.fn();
    const logger = { warn } as any;
    const api = new SpotifyConnectApi(token(), { http, sleep: noSleep, logger });
    await expect(api.play("dev-1", "spotify:track:abc")).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a non-transient 403 (exactly ONE call, no throw)", async () => {
    const put = vi.fn().mockRejectedValue(rejectStatus(403));
    const http = makeHttp({ put });
    const api = new SpotifyConnectApi(token(), { http, sleep: noSleep });
    await expect(api.play("dev-1", "spotify:track:abc")).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("429 honors a CAPPED Retry-After then succeeds (2 calls, bounded sleep)", async () => {
    const put = vi
      .fn()
      .mockRejectedValueOnce(rejectStatus(429, { "retry-after": "1" }))
      .mockResolvedValueOnce({ status: 200, data: {} });
    const http = makeHttp({ put });
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const api = new SpotifyConnectApi(token(), { http, sleep });
    await expect(api.play("dev-1", "spotify:track:abc")).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    const delay = sleep.mock.calls[0][0];
    expect(delay).toBe(1000);
    expect(delay).toBeLessThanOrEqual(2000);
  });

  it("transfer() shares the retry path — 404 then success (2 calls)", async () => {
    const put = vi
      .fn()
      .mockRejectedValueOnce(rejectStatus(404))
      .mockResolvedValueOnce({ status: 200, data: {} });
    const http = makeHttp({ put });
    const api = new SpotifyConnectApi(token(), { http, sleep: noSleep });
    await expect(api.transfer("dev-1", true)).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(2);
  });
});

describe("SpotifyConnectApi.getPlaybackState", () => {
  it("GETs /v1/me/player and maps is_playing/progress/item", async () => {
    const http = makeHttp({
      get: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          is_playing: true,
          progress_ms: 12345,
          item: { uri: "spotify:track:abc", duration_ms: 200000 },
        },
      }),
    });
    const api = new SpotifyConnectApi(token(), { http });
    const state = await api.getPlaybackState();
    expect(http.get).toHaveBeenCalledWith("/v1/me/player", AUTH);
    expect(state).toEqual({
      isPlaying: true,
      progressMs: 12345,
      trackUri: "spotify:track:abc",
      durationMs: 200000,
    });
  });

  // R4-4 (multi-bot): the account-wide /v1/me/player response names the single
  // ACTIVE Connect device. Expose it as activeDeviceId so the Rust backend can
  // tell "our device" from a foreign device another bot stole the session with.
  it("maps device.id -> activeDeviceId", async () => {
    const http = makeHttp({
      get: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          is_playing: true,
          progress_ms: 1000,
          item: { uri: "spotify:track:abc", duration_ms: 200000 },
          device: { id: "dev-1", name: "TS Bot", is_active: true },
        },
      }),
    });
    const api = new SpotifyConnectApi(token(), { http });
    const state = await api.getPlaybackState();
    expect(state).toEqual({
      isPlaying: true,
      progressMs: 1000,
      trackUri: "spotify:track:abc",
      durationMs: 200000,
      activeDeviceId: "dev-1",
    });
  });

  it("returns null on 204 (no active device)", async () => {
    const http = makeHttp({ get: vi.fn().mockResolvedValue({ status: 204, data: "" }) });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.getPlaybackState()).resolves.toBeNull();
  });

  it("returns null when item is missing / trackUri null", async () => {
    const http = makeHttp({
      get: vi.fn().mockResolvedValue({ status: 200, data: { is_playing: false, progress_ms: 0, item: null } }),
    });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.getPlaybackState()).resolves.toEqual({
      isPlaying: false,
      progressMs: 0,
      trackUri: null,
      durationMs: 0,
    });
  });

  it("returns null on rejection (e.g. 401) instead of throwing", async () => {
    const http = makeHttp({ get: vi.fn().mockRejectedValue(new Error("boom")) });
    const api = new SpotifyConnectApi(token(), { http });
    await expect(api.getPlaybackState()).resolves.toBeNull();
  });

  it("returns null when getToken() is null (unauthorized) without calling http", async () => {
    const http = makeHttp();
    const api = new SpotifyConnectApi(vi.fn().mockResolvedValue(null), { http });
    await expect(api.getPlaybackState()).resolves.toBeNull();
    expect(http.get).not.toHaveBeenCalled();
  });
});
