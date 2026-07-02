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

function makeHarness() {
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
    apiPort: 3678,
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
