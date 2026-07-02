import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { RustLibrespotBackend } from "./rust-librespot.js";

const log = pino({ level: "silent" });

/** ChildProcess stand-in with real Readable/Writable pipes so stdout->stdin piping works. */
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function makeConnect() {
  return {
    getDevices: vi.fn(async () => [{ id: "dev1", name: "Test Bot", is_active: false }]),
    findDeviceByName: vi.fn(async () => "dev1"),
    transfer: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    getPlaybackState: vi.fn(async () => null as any),
  };
}

function makeOAuth() {
  return {
    getAccessToken: vi.fn(async () => "tok-123" as string | null),
    isAuthorized: () => true,
  };
}

function makeHarness(over: { connect?: any; oauth?: any } = {}) {
  const calls: string[] = [];
  const librespotChild = makeFakeChild();
  const ffmpegChild = makeFakeChild();

  const spawn = vi.fn((cmd: string, ..._rest: any[]) => {
    const isLibrespot = cmd.includes("librespot");
    calls.push(`spawn:${isLibrespot ? "librespot" : cmd}`);
    return isLibrespot ? librespotChild : ffmpegChild;
  });
  const mkdirSync = vi.fn();
  const connect = over.connect ?? makeConnect();
  const oauth = over.oauth ?? makeOAuth();

  const backend = new RustLibrespotBackend({
    deviceName: "Test Bot",
    bitrate: 320,
    cacheDir: "/tmp/cache",
    oauth: oauth as any,
    connect: connect as any,
    logger: log,
    deps: {
      spawn: spawn as any,
      mkdirSync: mkdirSync as any,
      findBinary: () => "/bin/librespot",
      // C1: pin ffmpeg so arg-array assertions stay stable while prod uses getFfmpegCommand().
      ffmpegCommand: "ffmpeg",
      sleep: async () => {},
      readyPollIntervalMs: 1,
      readyTimeoutMs: 100,
      // huge so the background setInterval never fires; tests drive pollState() directly.
      statePollIntervalMs: 10_000_000,
    },
  });

  return { backend, calls, spawn, mkdirSync, connect, oauth, librespotChild, ffmpegChild };
}

describe("RustLibrespotBackend.start", () => {
  it("spawns librespot with the pipe/stdout arg set and the OAuth access token", async () => {
    const h = makeHarness();
    await h.backend.start();
    expect(h.spawn).toHaveBeenCalledWith(
      "/bin/librespot",
      [
        "--name", "Test Bot",
        "--backend", "pipe",
        "--bitrate", "320",
        "--format", "S16",
        "--cache", "/tmp/cache",
        "--device-type", "speaker",
        "--access-token", "tok-123",
      ],
      expect.anything(),
    );
    // NO --device (=> stdout) and NO --passthrough (=> decoded PCM, not Ogg).
    const args = h.spawn.mock.calls.find((c) => String(c[0]).includes("librespot"))![1] as string[];
    expect(args).not.toContain("--device");
    expect(args).not.toContain("--passthrough");
    h.backend.stop();
  });

  it("spawns ffmpeg (reader) before librespot (writer) with the exact 44100->48000 s16le args", async () => {
    const h = makeHarness();
    await h.backend.start();
    const ffmpegArgs = h.spawn.mock.calls.find((c) => c[0] === "ffmpeg")![1] as string[];
    expect(ffmpegArgs).toEqual([
      "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "pipe:0",
      "-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "pipe:1",
    ]);
    const ffmpegIdx = h.calls.indexOf("spawn:ffmpeg");
    const librespotIdx = h.calls.indexOf("spawn:librespot");
    expect(ffmpegIdx).toBeGreaterThanOrEqual(0);
    expect(librespotIdx).toBeGreaterThan(ffmpegIdx);
    h.backend.stop();
  });

  it("getPcmStream() returns the ffmpeg stdout Readable", async () => {
    const h = makeHarness();
    await h.backend.start();
    expect(h.backend.getPcmStream()).toBe(h.ffmpegChild.stdout);
    h.backend.stop();
  });

  it("emits 'ready' and reports isReady() true once our device appears in getDevices()", async () => {
    const h = makeHarness();
    const ready = vi.fn();
    h.backend.on("ready", ready);
    await h.backend.start();
    expect(h.connect.getDevices).toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(h.backend.isReady()).toBe(true);
    h.backend.stop();
  });

  it("keeps polling getDevices() until the device name appears", async () => {
    const h = makeHarness();
    h.connect.getDevices
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "other", name: "Someone else", is_active: true }])
      .mockResolvedValue([{ id: "dev1", name: "Test Bot", is_active: false }]);
    await h.backend.start();
    expect(h.connect.getDevices).toHaveBeenCalledTimes(3);
    expect(h.backend.isReady()).toBe(true);
    h.backend.stop();
  });

  it("throws (and does not spawn) when the OAuth token is null", async () => {
    const oauth = makeOAuth();
    oauth.getAccessToken.mockResolvedValue(null);
    const h = makeHarness({ oauth });
    await expect(h.backend.start()).rejects.toThrow(/authorized|token/i);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe("RustLibrespotBackend transport delegation (Connect API)", () => {
  it("playTrack resolves the device then transfer(false) then play(uri)", async () => {
    const h = makeHarness();
    await h.backend.playTrack("spotify:track:go");
    expect(h.connect.findDeviceByName).toHaveBeenCalledWith("Test Bot");
    expect(h.connect.transfer).toHaveBeenCalledWith("dev1", false);
    expect(h.connect.play).toHaveBeenCalledWith("dev1", "spotify:track:go");
    // ordering: transfer before play
    expect(h.connect.transfer.mock.invocationCallOrder[0])
      .toBeLessThan(h.connect.play.mock.invocationCallOrder[0]);
  });

  it("playTrack throws when the device cannot be found", async () => {
    const h = makeHarness();
    h.connect.findDeviceByName.mockResolvedValue(null);
    await expect(h.backend.playTrack("spotify:track:x")).rejects.toThrow(/device/i);
  });

  it("pause/resume/seek delegate to the Connect API and seek updates position", async () => {
    const h = makeHarness();
    await h.backend.pause();
    await h.backend.resume();
    await h.backend.seek(5000);
    expect(h.connect.pause).toHaveBeenCalled();
    expect(h.connect.resume).toHaveBeenCalled();
    expect(h.connect.seek).toHaveBeenCalledWith(5000);
    expect(h.backend.getPositionMs()).toBe(5000);
  });
});

describe("RustLibrespotBackend track-end poll loop", () => {
  it("emits trackEnded when progress reaches the end-of-track window", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    const meta = vi.fn();
    h.backend.on("trackEnded", ended);
    h.backend.on("metadata", meta);
    h.connect.getPlaybackState
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 1000, trackUri: "spotify:track:A", durationMs: 200000 })
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 199000, trackUri: "spotify:track:A", durationMs: 200000 });
    await (h.backend as any).pollState();
    expect(meta).toHaveBeenCalledWith(expect.objectContaining({ uri: "spotify:track:A", durationMs: 200000 }));
    expect(h.backend.getPositionMs()).toBe(1000);
    expect(ended).not.toHaveBeenCalled();
    await (h.backend as any).pollState();
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:A", reason: "ended" });
  });

  it("emits trackEnded once when playback stops (!isPlaying) after having played", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.connect.getPlaybackState
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000 })
      .mockResolvedValueOnce({ isPlaying: false, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000 })
      .mockResolvedValue({ isPlaying: false, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000 });
    await (h.backend as any).pollState();
    await (h.backend as any).pollState();
    await (h.backend as any).pollState(); // idempotent: no second emit for same track
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:A", reason: "ended" });
  });

  it("emits trackEnded when the track uri transitions to null after playing", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.connect.getPlaybackState
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 1000, trackUri: "spotify:track:A", durationMs: 200000 })
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 0, trackUri: null, durationMs: 0 });
    await (h.backend as any).pollState();
    await (h.backend as any).pollState();
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:A", reason: "ended" });
  });

  it("ignores a null playback state (no active device) without emitting", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.connect.getPlaybackState.mockResolvedValue(null);
    await (h.backend as any).pollState();
    expect(ended).not.toHaveBeenCalled();
  });
});

describe("RustLibrespotBackend.stop", () => {
  it("kills librespot + ffmpeg, clears ready, and is idempotent", async () => {
    const h = makeHarness();
    await h.backend.start();
    h.backend.stop();
    h.backend.stop(); // second call must not throw
    expect(h.librespotChild.kill).toHaveBeenCalled();
    expect(h.ffmpegChild.kill).toHaveBeenCalled();
    expect(h.backend.isReady()).toBe(false);
  });
});

describe("RustLibrespotBackend.start failure cleanup", () => {
  it("tears down librespot + ffmpeg when the device never appears", async () => {
    const h = makeHarness();
    h.connect.getDevices.mockResolvedValue([]); // device never shows up -> waitForDevice times out
    await expect(h.backend.start()).rejects.toThrow(/did not appear/i);
    expect(h.librespotChild.kill).toHaveBeenCalled();
    expect(h.ffmpegChild.kill).toHaveBeenCalled();
    expect(h.backend.isReady()).toBe(false);
  });
});

describe("RustLibrespotBackend child-process error handling", () => {
  it("swallows+logs a child 'error' when no backend 'error' listener is attached", async () => {
    const h = makeHarness();
    await h.backend.start();
    expect(h.backend.listenerCount("error")).toBe(0);
    expect(() => h.librespotChild.emit("error", new Error("boom"))).not.toThrow();
    expect(() => h.ffmpegChild.emit("error", new Error("boom"))).not.toThrow();
    h.backend.stop();
  });

  it("re-emits a child 'error' to an attached backend 'error' listener", async () => {
    const h = makeHarness();
    await h.backend.start();
    const onErr = vi.fn();
    h.backend.on("error", onErr);
    const err = new Error("ffmpeg boom");
    h.ffmpegChild.emit("error", err);
    expect(onErr).toHaveBeenCalledWith(err);
    h.backend.stop();
  });
});
