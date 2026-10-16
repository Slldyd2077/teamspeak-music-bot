import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { GoLibrespotBackend } from "./go-librespot.js";

const log = pino({ level: "silent" });

/** A minimal stand-in for a spawned ChildProcess with real Readable stdout/stderr. */
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function makeHarness(portOpts: { apiPort?: number; callbackPort?: number } = {}) {
  const calls: string[] = [];
  const ffmpegChild = makeFakeChild();
  const gliChild = makeFakeChild();

  const spawn = vi.fn((cmd: string, ..._rest: any[]) => {
    const isGli = cmd.includes("go-librespot");
    calls.push(`spawn:${isGli ? "go-librespot" : cmd}`);
    return isGli ? gliChild : ffmpegChild;
  });
  const execFileSync = vi.fn((cmd: string) => {
    calls.push(`exec:${cmd}`);
    return Buffer.from("");
  });
  const writeFileSync = vi.fn(() => calls.push("write:config"));
  const mkdirSync = vi.fn();
  const unlinkSync = vi.fn(() => calls.push("unlink:fifo"));
  const existsSync = vi.fn(() => false);

  const rest = {
    ping: vi.fn(async () => true),
    playTrack: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    getStatus: vi.fn(async () => null),
  };
  const events: any = new EventEmitter();
  events.start = vi.fn(() => calls.push("ws:start"));
  events.stop = vi.fn();

  const backend = new GoLibrespotBackend({
    deviceName: "Test Bot",
    bitrate: 320,
    workDir: "/tmp/work",
    configDir: "/tmp/cfg",
    apiPort: portOpts.apiPort ?? 3678,
    callbackPort: portOpts.callbackPort,
    logger: log,
    deps: {
      spawn,
      execFileSync,
      writeFileSync,
      mkdirSync,
      unlinkSync,
      existsSync,
      // C1: pin the ffmpeg command so the arg-array/order assertions below stay
      // stable while production resolves ffmpeg via getFfmpegCommand() (which
      // falls back to bundled ffmpeg-static when `ffmpeg` isn't on PATH).
      ffmpegCommand: "ffmpeg",
      findBinary: () => "/bin/go-librespot",
      makeRest: () => rest,
      makeEvents: () => events,
      sleep: async () => {},
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
    } as any,
  });

  return { backend, calls, spawn, execFileSync, writeFileSync, existsSync, unlinkSync, rest, events, ffmpegChild, gliChild };
}

describe("GoLibrespotBackend.start", () => {
  it("creates the FIFO with mkfifo before spawning ffmpeg, and spawns ffmpeg BEFORE go-librespot", async () => {
    const h = makeHarness();
    await h.backend.start();

    expect(h.execFileSync).toHaveBeenCalledWith("mkfifo", ["/tmp/work/go-librespot.fifo"]);
    expect(h.writeFileSync).toHaveBeenCalled();

    const mkfifoIdx = h.calls.indexOf("exec:mkfifo");
    const ffmpegIdx = h.calls.indexOf("spawn:ffmpeg");
    const gliIdx = h.calls.indexOf("spawn:go-librespot");
    expect(mkfifoIdx).toBeGreaterThanOrEqual(0);
    expect(ffmpegIdx).toBeGreaterThan(mkfifoIdx); // ffmpeg attaches to the FIFO first
    expect(gliIdx).toBeGreaterThan(ffmpegIdx);     // then the writer (go-librespot)
    expect(h.calls.indexOf("ws:start")).toBeGreaterThan(gliIdx); // WS connects last
  });

  it("passes --config_dir to go-librespot using the resolved binary path", async () => {
    const h = makeHarness();
    await h.backend.start();
    expect(h.spawn).toHaveBeenCalledWith(
      "/bin/go-librespot",
      ["--config_dir", "/tmp/cfg"],
      expect.anything(),
    );
  });

  it("uses the 44100->48000 s16le ffmpeg command reading the FIFO", async () => {
    const h = makeHarness();
    await h.backend.start();
    const ffmpegArgs = h.spawn.mock.calls.find((c) => c[0] === "ffmpeg")![1] as string[];
    expect(ffmpegArgs).toEqual([
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "/tmp/work/go-librespot.fifo",
      "-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "pipe:1",
    ]);
  });

  it("emits 'ready' and reports isReady() true once the REST ping succeeds", async () => {
    const h = makeHarness();
    const ready = vi.fn();
    h.backend.on("ready", ready);
    await h.backend.start();
    expect(h.rest.ping).toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(h.backend.isReady()).toBe(true);
  });

  it("keeps polling ping() until it returns true", async () => {
    const h = makeHarness();
    h.rest.ping.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    await h.backend.start();
    expect(h.rest.ping).toHaveBeenCalledTimes(3);
    expect(h.backend.isReady()).toBe(true);
  });
});

describe("GoLibrespotBackend config binding (Fix 1 loopback + Fix 3 ports)", () => {
  function writtenYml(h: ReturnType<typeof makeHarness>): string {
    const calls = h.writeFileSync.mock.calls as unknown as any[][];
    const call = calls.find((c) => String(c[0]).endsWith("config.yml"));
    expect(call).toBeDefined();
    return call![1] as string;
  }

  it("binds the control API to loopback (127.0.0.1), never 0.0.0.0", async () => {
    const h = makeHarness();
    await h.backend.start();
    const yml = writtenYml(h);
    expect(yml).toContain("address: 127.0.0.1");
    expect(yml).not.toContain("0.0.0.0");
  });

  it("threads apiPort + callbackPort into the rendered config", async () => {
    const h = makeHarness({ apiPort: 3712, callbackPort: 8712 });
    await h.backend.start();
    const yml = writtenYml(h);
    expect(yml).toContain("port: 3712");
    expect(yml).toContain("callback_port: 8712");
  });

  it("defaults callbackPort to 8080 when unset", async () => {
    const h = makeHarness();
    await h.backend.start();
    expect(writtenYml(h)).toContain("callback_port: 8080");
  });
});

describe("GoLibrespotBackend WebSocket event mapping", () => {
  it("maps a not_playing event to trackEnded{reason:'ended'}", async () => {
    const h = makeHarness();
    await h.backend.start();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.events.emit("not_playing", { uri: "spotify:track:abc" });
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:abc", reason: "ended" });
  });

  it("maps a stopped event to trackEnded{reason:'stopped'}", async () => {
    const h = makeHarness();
    await h.backend.start();
    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.events.emit("stopped", { uri: "spotify:track:xyz" });
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:xyz", reason: "stopped" });
  });

  it("maps a metadata event to a SpotifyNowPlaying and updates getPositionMs()", async () => {
    const h = makeHarness();
    await h.backend.start();
    const meta = vi.fn();
    h.backend.on("metadata", meta);
    h.events.emit("metadata", {
      uri: "spotify:track:abc",
      name: "Song",
      artist_names: ["A", "B"],
      album_name: "Alb",
      album_cover_url: "http://x/y.jpg",
      position: 1234,
      duration: 200000,
    });
    expect(meta).toHaveBeenCalledWith({
      uri: "spotify:track:abc",
      name: "Song",
      artist: "A, B",
      album: "Alb",
      coverUrl: "http://x/y.jpg",
      durationMs: 200000,
    });
    expect(h.backend.getPositionMs()).toBe(1234);
  });
});

describe("GoLibrespotBackend transport delegation + PCM", () => {
  it("playTrack delegates to the REST client", async () => {
    const h = makeHarness();
    await h.backend.start();
    await h.backend.playTrack("spotify:track:go");
    expect(h.rest.playTrack).toHaveBeenCalledWith("spotify:track:go");
  });

  it("pause/resume/seek delegate to the REST client and seek updates position", async () => {
    const h = makeHarness();
    await h.backend.start();
    await h.backend.pause();
    await h.backend.resume();
    await h.backend.seek(5000);
    expect(h.rest.pause).toHaveBeenCalled();
    expect(h.rest.resume).toHaveBeenCalled();
    expect(h.rest.seek).toHaveBeenCalledWith(5000);
    expect(h.backend.getPositionMs()).toBe(5000);
  });

  it("getPcmStream() returns the ffmpeg stdout Readable", async () => {
    const h = makeHarness();
    await h.backend.start();
    expect(h.backend.getPcmStream()).toBe(h.ffmpegChild.stdout);
  });
});

describe("GoLibrespotBackend.stop", () => {
  it("kills ffmpeg + go-librespot, stops the WS, removes the FIFO, and clears ready", async () => {
    const h = makeHarness();
    await h.backend.start();
    h.existsSync.mockReturnValue(true); // FIFO now present, so stop() unlinks it
    h.backend.stop();
    expect(h.ffmpegChild.kill).toHaveBeenCalled();
    expect(h.gliChild.kill).toHaveBeenCalled();
    expect(h.events.stop).toHaveBeenCalled();
    expect(h.unlinkSync).toHaveBeenCalledWith("/tmp/work/go-librespot.fifo");
    expect(h.backend.isReady()).toBe(false);
  });
});

describe("GoLibrespotBackend.start failure cleanup", () => {
  it("tears down ffmpeg, go-librespot, and the FIFO when readiness polling never succeeds", async () => {
    const h = makeHarness();
    // ping() never returns true → waitUntilReady() times out → start() rejects
    // AFTER both processes were spawned and the FIFO was created.
    h.rest.ping.mockResolvedValue(false);
    // FIFO present so the cleanup path unlinks it.
    h.existsSync.mockReturnValue(true);

    await expect(h.backend.start()).rejects.toThrow(/did not become ready/);

    expect(h.ffmpegChild.kill).toHaveBeenCalled(); // ffmpeg killed on failed startup
    expect(h.gliChild.kill).toHaveBeenCalled(); // go-librespot killed on failed startup
    expect(h.unlinkSync).toHaveBeenCalledWith("/tmp/work/go-librespot.fifo"); // FIFO removed
    expect(h.backend.isReady()).toBe(false);
  });
});

describe("GoLibrespotBackend child-process error handling", () => {
  it("does not throw when a child 'error' is emitted with no backend 'error' listener attached", async () => {
    const h = makeHarness();
    await h.backend.start();
    // No "error" listener on the backend: an unhandled 'error' event would crash
    // Node, so the backend must swallow+log it instead of re-emitting.
    expect(h.backend.listenerCount("error")).toBe(0);
    expect(() => h.ffmpegChild.emit("error", new Error("ffmpeg boom"))).not.toThrow();
    expect(() => h.gliChild.emit("error", new Error("gli boom"))).not.toThrow();
  });

  it("re-emits a child 'error' to an attached backend 'error' listener", async () => {
    const h = makeHarness();
    await h.backend.start();
    const onErr = vi.fn();
    h.backend.on("error", onErr);
    const err = new Error("ffmpeg boom");
    h.ffmpegChild.emit("error", err);
    expect(onErr).toHaveBeenCalledWith(err);
  });
});

// Let queued microtasks (the async reconnect re-sync) settle.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("GoLibrespotBackend R4-2: unexpected sidecar exit recovery", () => {
  it("degrades to trackEnded{reason:'error'}, surfaces 'error', and stops the WS on an UNEXPECTED exit", async () => {
    const h = makeHarness();
    await h.backend.start();
    await h.backend.playTrack("spotify:track:cur"); // sets the current uri

    const ended = vi.fn();
    const onErr = vi.fn();
    h.backend.on("trackEnded", ended);
    h.backend.on("error", onErr);

    // Sidecar dies under us (nonzero exit, no stop() from us).
    h.gliChild.emit("exit", 1, null);

    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:cur", reason: "error" });
    expect(onErr).toHaveBeenCalledTimes(1); // controller told -> rebuilds on next ensureStarted
    expect(h.events.stop).toHaveBeenCalled(); // WS reconnect loop stopped (no dead-port hammer)
    expect(h.backend.isReady()).toBe(false);
  });

  it("emits trackEnded BEFORE error so a listener that tears down still receives the skip", async () => {
    const h = makeHarness();
    await h.backend.start();
    await h.backend.playTrack("spotify:track:cur");

    const order: string[] = [];
    h.backend.on("trackEnded", () => order.push("trackEnded"));
    h.backend.on("error", () => order.push("error"));
    h.gliChild.emit("exit", null, "SIGKILL");

    expect(order).toEqual(["trackEnded", "error"]);
  });

  it("a stop()-initiated exit emits NEITHER trackEnded NOR error", async () => {
    const h = makeHarness();
    await h.backend.start();
    await h.backend.playTrack("spotify:track:cur");

    const ended = vi.fn();
    const onErr = vi.fn();
    h.backend.on("trackEnded", ended);
    h.backend.on("error", onErr);

    h.backend.stop(); // intentional teardown -> the ensuing 'exit' must be silent
    h.gliChild.emit("exit", 0, "SIGTERM");

    expect(ended).not.toHaveBeenCalled();
    expect(onErr).not.toHaveBeenCalled();
  });
});

describe("GoLibrespotBackend R4-3: WS reconnect re-sync", () => {
  const notPlaying = { stopped: true, paused: false, buffering: false, track: null };
  const stillPlaying = {
    stopped: false,
    paused: false,
    buffering: false,
    track: {
      uri: "spotify:track:cur",
      name: "Song",
      artist_names: ["A"],
      album_name: "Alb",
      album_cover_url: null,
      position: 1000,
      duration: 200000,
    },
  };

  it("re-queries GET /status on reconnect and emits trackEnded when playback is no longer active", async () => {
    const h = makeHarness();
    await h.backend.start();
    await h.backend.playTrack("spotify:track:cur");
    h.rest.getStatus.mockResolvedValue(notPlaying as any);

    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.events.emit("reconnected");
    await flush();

    expect(h.rest.getStatus).toHaveBeenCalled();
    expect(ended).toHaveBeenCalledWith({ uri: "spotify:track:cur", reason: "ended" });
  });

  it("does NOT emit a spurious trackEnded on reconnect when status shows still-playing", async () => {
    const h = makeHarness();
    await h.backend.start();
    await h.backend.playTrack("spotify:track:cur");
    h.rest.getStatus.mockResolvedValue(stillPlaying as any);

    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.events.emit("reconnected");
    await flush();

    expect(h.rest.getStatus).toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });

  it("re-sync is idempotent: a reconnect then a live not_playing emits trackEnded only once", async () => {
    const h = makeHarness();
    await h.backend.start();
    await h.backend.playTrack("spotify:track:cur");
    h.rest.getStatus.mockResolvedValue(notPlaying as any);

    const ended = vi.fn();
    h.backend.on("trackEnded", ended);
    h.events.emit("reconnected");
    await flush();
    // A duplicate live event for the same track must not double-advance the queue.
    h.events.emit("not_playing", { uri: "spotify:track:cur" });

    expect(ended).toHaveBeenCalledTimes(1);
  });
});
