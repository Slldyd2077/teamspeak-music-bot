import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { RustLibrespotBackend, type RustLibrespotBackendDeps } from "./rust-librespot.js";

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

function makeHarness(
  over: { connect?: any; oauth?: any; deps?: Partial<RustLibrespotBackendDeps> } = {},
) {
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
      ...over.deps,
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
    // Arm detection the way production does — via our own playTrack().
    await h.backend.playTrack("spotify:track:A");
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

  // C1(pause-skip): a USER pause reports is_playing:false with the SAME uri on
  // the Rust backend. That MUST NOT be read as a track end (it would skip the
  // paused track and break pause + occupancy auto-pause). Formerly the
  // "!isPlaying after having played" test asserted the opposite — that encoded
  // the bug; it is now split into this pause-no-skip test plus the two-poll
  // external-stop test below.
  it("does NOT emit trackEnded when the user PAUSES (self-initiated pause is not a track end)", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    await h.backend.playTrack("spotify:track:A");
    // Observe our track actually playing first.
    h.connect.getPlaybackState.mockResolvedValueOnce({
      isPlaying: true, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000,
    });
    await (h.backend as any).pollState();
    // User pauses: the Connect device stays loaded but reports is_playing:false
    // with the SAME uri across every subsequent poll while paused.
    await h.backend.pause();
    h.connect.getPlaybackState.mockResolvedValue({
      isPlaying: false, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000,
    });
    await (h.backend as any).pollState();
    await (h.backend as any).pollState(); // stays paused across multiple polls
    expect(ended).not.toHaveBeenCalled();
    // Resuming keeps the same track playing — still no spurious end.
    await h.backend.resume();
    h.connect.getPlaybackState.mockResolvedValue({
      isPlaying: true, progressMs: 6000, trackUri: "spotify:track:A", durationMs: 200000,
    });
    await (h.backend as any).pollState();
    expect(ended).not.toHaveBeenCalled();
  });

  it("emits trackEnded once on an EXTERNAL stop only after TWO consecutive !isPlaying polls (a transient mid-track !isPlaying is not a skip)", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    await h.backend.playTrack("spotify:track:A");
    h.connect.getPlaybackState
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000 })
      .mockResolvedValueOnce({ isPlaying: false, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000 })
      .mockResolvedValue({ isPlaying: false, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000 });
    await (h.backend as any).pollState(); // observed playing
    await (h.backend as any).pollState(); // FIRST !isPlaying -> unconfirmed (could be transient buffering)
    expect(ended).not.toHaveBeenCalled();
    await (h.backend as any).pollState(); // SECOND consecutive !isPlaying -> confirmed external stop
    await (h.backend as any).pollState(); // idempotent: no second emit for same track
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:A", reason: "ended" });
  });

  it("a transient single !isPlaying poll followed by playing again does NOT emit trackEnded (buffering hiccup)", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    await h.backend.playTrack("spotify:track:A");
    h.connect.getPlaybackState
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000 })
      .mockResolvedValueOnce({ isPlaying: false, progressMs: 5000, trackUri: "spotify:track:A", durationMs: 200000 })
      .mockResolvedValue({ isPlaying: true, progressMs: 6000, trackUri: "spotify:track:A", durationMs: 200000 });
    await (h.backend as any).pollState(); // playing
    await (h.backend as any).pollState(); // momentary !isPlaying (buffering)
    await (h.backend as any).pollState(); // playing again -> stop confirmation reset
    expect(ended).not.toHaveBeenCalled();
  });

  // m(sub-window): a track SHORTER than the end-of-track window must not be
  // declared finished on its first observed-playing poll (durationMs - window
  // is negative, so the old near-end check fired unconditionally).
  it("does NOT false-finish a sub-window (< END_OF_TRACK_WINDOW_MS) duration on the first playing poll", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    await h.backend.playTrack("spotify:track:short");
    h.connect.getPlaybackState.mockResolvedValue({
      isPlaying: true, progressMs: 100, trackUri: "spotify:track:short", durationMs: 1200,
    });
    await (h.backend as any).pollState();
    expect(ended).not.toHaveBeenCalled();
  });

  it("emits trackEnded when the track uri transitions to null after playing", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    await h.backend.playTrack("spotify:track:A");
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

  it("C3.4: a startup poll before playTrack never emits (foreign track near its end)", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    const meta = vi.fn();
    h.backend.on("trackEnded", ended);
    h.backend.on("metadata", meta);
    // Backend started, but playTrack has NOT been called => detection disarmed.
    await h.backend.start();
    // First poll observes a FOREIGN track that is actively playing near its end.
    h.connect.getPlaybackState.mockResolvedValue({
      isPlaying: true,
      progressMs: 199000,
      trackUri: "spotify:foreign",
      durationMs: 200000,
    });
    await (h.backend as any).pollState();
    // No spurious end-of-track and no bogus metadata before the bot ever plays.
    expect(ended).not.toHaveBeenCalled();
    expect(meta).not.toHaveBeenCalled();
    expect(h.backend.getPositionMs()).toBe(0);
    h.backend.stop();
  });

  it("after playTrack, a normal finish emits trackEnded exactly once for our uri", async () => {
    const h = makeHarness();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    // Arm detection via our own play, then confirm-then-finish our uri.
    await h.backend.playTrack("spotify:track:ours");
    h.connect.getPlaybackState
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 1000, trackUri: "spotify:track:ours", durationMs: 200000 })
      .mockResolvedValueOnce({ isPlaying: true, progressMs: 199000, trackUri: "spotify:track:ours", durationMs: 200000 });
    await (h.backend as any).pollState(); // confirms our uri playing
    expect(ended).not.toHaveBeenCalled();
    await (h.backend as any).pollState(); // finishes
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:ours", reason: "ended" });
  });
});

describe("RustLibrespotBackend playback-start watchdog (I4 degrade-to-skip)", () => {
  /** A controllable timer seam matching the file's injected-deps style. */
  function makeFakeTimer() {
    const pending: Array<{ cb: () => void; ms: number; handle: object }> = [];
    const setTimer = vi.fn((cb: () => void, ms: number) => {
      const handle = {};
      pending.push({ cb, ms, handle });
      return handle;
    });
    const clearTimer = vi.fn((h: unknown) => {
      const i = pending.findIndex((p) => p.handle === h);
      if (i >= 0) pending.splice(i, 1);
    });
    // "advance fake timers": run (and drain) every armed callback.
    const advance = () => pending.splice(0).forEach((p) => p.cb());
    return { setTimer, clearTimer, advance, pending };
  }

  it("emits exactly ONE trackEnded{reason:'error'} when playback never starts", async () => {
    const timer = makeFakeTimer();
    const h = makeHarness({
      deps: {
        playbackStartTimeoutMs: 8000,
        setTimeout: timer.setTimer as any,
        clearTimeout: timer.clearTimer as any,
      },
    });
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);

    // The connect layer NEVER reports our track playing (204 / idle).
    h.connect.getPlaybackState.mockResolvedValue(null);
    await h.backend.playTrack("spotify:track:stuck");
    // Polls that never observe playback must NOT emit anything on their own.
    await (h.backend as any).pollState();
    await (h.backend as any).pollState();
    expect(ended).not.toHaveBeenCalled();

    // The watchdog is armed exactly once; advance past playbackStartTimeoutMs.
    expect(timer.pending).toHaveLength(1);
    expect(timer.pending[0].ms).toBe(8000);
    timer.advance();

    // Degraded-to-skip: one trackEnded with reason "error" for our uri.
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:stuck", reason: "error" });

    // A late idle poll after the watchdog fired does not double-emit.
    await (h.backend as any).pollState();
    expect(ended).toHaveBeenCalledTimes(1);
    h.backend.stop();
  });

  it("does NOT fire the watchdog when the device actually starts playing", async () => {
    const timer = makeFakeTimer();
    const h = makeHarness({
      deps: {
        playbackStartTimeoutMs: 8000,
        setTimeout: timer.setTimer as any,
        clearTimeout: timer.clearTimer as any,
      },
    });
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);

    await h.backend.playTrack("spotify:track:ok");
    // Our device reports the track actually playing -> watchdog is disarmed.
    h.connect.getPlaybackState.mockResolvedValue({
      isPlaying: true,
      progressMs: 1000,
      trackUri: "spotify:track:ok",
      durationMs: 200000,
    });
    await (h.backend as any).pollState();

    // Real playback observed -> the watchdog was cleared, not left armed.
    expect(timer.clearTimer).toHaveBeenCalled();
    expect(timer.pending).toHaveLength(0);
    // Even if a stale timer somehow fired, no "error" end must be emitted.
    timer.advance();
    expect(ended).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "error" }),
    );
    h.backend.stop();
  });

  it("a new playTrack() cancels the previous track's watchdog (at-most-one per track)", async () => {
    const timer = makeFakeTimer();
    const h = makeHarness({
      deps: {
        playbackStartTimeoutMs: 8000,
        setTimeout: timer.setTimer as any,
        clearTimeout: timer.clearTimer as any,
      },
    });
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.connect.getPlaybackState.mockResolvedValue(null);

    await h.backend.playTrack("spotify:track:one");
    await h.backend.playTrack("spotify:track:two");
    // The first track's watchdog was cleared; only the second remains armed.
    expect(timer.clearTimer).toHaveBeenCalled();
    expect(timer.pending).toHaveLength(1);
    timer.advance();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:two", reason: "error" });
    h.backend.stop();
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

  // I(pipe): ffmpeg dying mid-track while librespot keeps producing PCM raises
  // EPIPE on ffmpeg.stdin. With no stdin 'error' listener Node escalates it to
  // process 'uncaughtException'. The backend must handle it in-band.
  it("swallows an EPIPE 'error' on ffmpeg.stdin (ffmpeg died mid-track) without an unhandled throw", async () => {
    const h = makeHarness();
    await h.backend.start();
    expect(h.backend.listenerCount("error")).toBe(0);
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => h.ffmpegChild.stdin.emit("error", epipe)).not.toThrow();
    h.backend.stop(); // idempotent second teardown must not throw
  });

  it("routes an ffmpeg.stdin EPIPE to the backend 'error' listener and tears down cleanly", async () => {
    const h = makeHarness();
    await h.backend.start();
    const onErr = vi.fn();
    h.backend.on("error", onErr);
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => h.ffmpegChild.stdin.emit("error", epipe)).not.toThrow();
    expect(onErr).toHaveBeenCalledWith(epipe);
    // Broken pipe -> clean teardown: children killed, not ready.
    expect(h.librespotChild.kill).toHaveBeenCalled();
    expect(h.ffmpegChild.kill).toHaveBeenCalled();
    expect(h.backend.isReady()).toBe(false);
    h.backend.stop(); // second teardown must not throw (no double-teardown crash)
    expect(onErr).toHaveBeenCalledTimes(1); // single emit despite both pipe ends
  });

  it("does not throw when librespot proc.stdout emits an EPIPE on the broken pipe", async () => {
    const h = makeHarness();
    await h.backend.start();
    const epipe = Object.assign(new Error("read/write EPIPE"), { code: "EPIPE" });
    expect(() => h.librespotChild.stdout.emit("error", epipe)).not.toThrow();
    h.backend.stop();
  });
});
