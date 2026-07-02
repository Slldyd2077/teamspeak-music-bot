import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "pino";
import type { SpotifyConfig } from "../../data/config.js";
import type {
  SpotifyAudioBackend,
  SpotifyTrackEndedEvent,
  SpotifyNowPlaying,
} from "./backend.js";

// Controllable, hoisted so the vi.mock factory can close over it.
const bin = vi.hoisted(() => ({ supported: true, path: "" }));
vi.mock("./binary.js", () => ({
  isGoLibrespotSupported: () => bin.supported,
  findGoLibrespot: () => bin.path,
  resetGoLibrespotBinaryCache: () => {},
  checkGoLibrespotAvailable: async () => bin.supported && !!bin.path,
}));

// Capture options the DEFAULT factory hands to the real GoLibrespotBackend so
// we can assert per-bot ports (Fix 3) are threaded through. Every other test
// injects its own backendFactory, so this mock is inert for them.
const goLibrespotCtor = vi.hoisted(() => vi.fn());
vi.mock("./go-librespot.js", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    GoLibrespotBackend: class extends EventEmitter {
      constructor(opts: any) {
        super();
        goLibrespotCtor(opts);
      }
      async start(): Promise<void> {}
      isReady(): boolean {
        return true;
      }
      stop(): void {}
      async playTrack(): Promise<void> {}
      async pause(): Promise<void> {}
      async resume(): Promise<void> {}
      async seek(): Promise<void> {}
      getPcmStream(): any {
        return null;
      }
      getPositionMs(): number {
        return 0;
      }
    },
  };
});

// Import AFTER vi.mock so the mocked binary module is used.
const { SpotifyController } = await import("./controller.js");

const existingBin = join(tmpdir(), `tsmb-golibrespot-${process.pid}`);
const missingBin = join(tmpdir(), `tsmb-golibrespot-missing-${process.pid}`);

beforeAll(() => {
  writeFileSync(existingBin, "#!/bin/sh\n");
});
afterAll(() => {
  try {
    rmSync(existingBin);
  } catch {
    /* ignore */
  }
});
beforeEach(() => {
  bin.supported = true;
  bin.path = existingBin;
});

class FakeBackend extends EventEmitter implements SpotifyAudioBackend {
  startCalls = 0;
  stopCalls = 0;
  playCalls: string[] = [];
  pauseCalls = 0;
  resumeCalls = 0;
  seekCalls: number[] = [];
  ready = false;
  startShouldReject = false;
  playShouldReject = false;
  readonly pcm = Readable.from([Buffer.alloc(0)]);

  async start(): Promise<void> {
    this.startCalls++;
    if (this.startShouldReject) throw new Error("start boom");
    this.ready = true;
  }
  stop(): void {
    this.stopCalls++;
    this.ready = false;
  }
  isReady(): boolean {
    return this.ready;
  }
  async playTrack(uri: string): Promise<void> {
    this.playCalls.push(uri);
    if (this.playShouldReject) throw new Error("play boom");
  }
  async pause(): Promise<void> {
    this.pauseCalls++;
  }
  async resume(): Promise<void> {
    this.resumeCalls++;
  }
  async seek(ms: number): Promise<void> {
    this.seekCalls.push(ms);
  }
  getPcmStream(): Readable {
    return this.pcm;
  }
  getPositionMs(): number {
    return 0;
  }
}

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return silentLogger;
  },
} as unknown as Logger;

function cfg(over: Partial<SpotifyConfig> = {}): SpotifyConfig {
  return {
    enabled: true,
    backend: "auto",
    clientId: "",
    clientSecret: "",
    deviceName: "TSMusicBot",
    bitrate: 320,
    ...over,
  };
}

function makeCtrl(over: {
  config?: Partial<SpotifyConfig>;
  backendFactory?: () => SpotifyAudioBackend;
} = {}) {
  const be = new FakeBackend();
  const ctrl = new SpotifyController({
    config: cfg(over.config),
    workDir: "/tmp/work",
    configDir: "/tmp/cfg",
    logger: silentLogger,
    backendFactory: over.backendFactory ?? (() => be),
  });
  return { ctrl, be };
}

describe("SpotifyController.isAvailable", () => {
  it("true when enabled + supported + binary present", () => {
    const { ctrl } = makeCtrl();
    expect(ctrl.isAvailable()).toBe(true);
  });
  it("false when config disabled", () => {
    const { ctrl } = makeCtrl({ config: { enabled: false } });
    expect(ctrl.isAvailable()).toBe(false);
  });
  it("false when platform unsupported", () => {
    bin.supported = false;
    const { ctrl } = makeCtrl();
    expect(ctrl.isAvailable()).toBe(false);
  });
  it("false when binary file is absent", () => {
    bin.path = missingBin;
    const { ctrl } = makeCtrl();
    expect(ctrl.isAvailable()).toBe(false);
  });
});

describe("SpotifyController.ensureStarted", () => {
  it("starts the backend exactly once across repeated calls", async () => {
    let built = 0;
    const be = new FakeBackend();
    const { ctrl } = makeCtrl({
      backendFactory: () => {
        built++;
        return be;
      },
    });
    expect(await ctrl.ensureStarted()).toBe(true);
    expect(await ctrl.ensureStarted()).toBe(true);
    expect(built).toBe(1);
    expect(be.startCalls).toBe(1);
  });

  it("is idempotent under concurrent calls (single start)", async () => {
    let built = 0;
    const be = new FakeBackend();
    const { ctrl } = makeCtrl({
      backendFactory: () => {
        built++;
        return be;
      },
    });
    const [a, b] = await Promise.all([ctrl.ensureStarted(), ctrl.ensureStarted()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(built).toBe(1);
    expect(be.startCalls).toBe(1);
  });

  it("returns false and does not build a backend when unavailable", async () => {
    let built = 0;
    const { ctrl } = makeCtrl({
      config: { enabled: false },
      backendFactory: () => {
        built++;
        return new FakeBackend();
      },
    });
    expect(await ctrl.ensureStarted()).toBe(false);
    expect(built).toBe(0);
  });

  it("returns false when backend.start() throws, and allows a later retry", async () => {
    const be = new FakeBackend();
    be.startShouldReject = true;
    let built = 0;
    const { ctrl } = makeCtrl({
      backendFactory: () => {
        built++;
        return be;
      },
    });
    expect(await ctrl.ensureStarted()).toBe(false);
    // start failure clears the cached promise so a subsequent call retries.
    be.startShouldReject = false;
    expect(await ctrl.ensureStarted()).toBe(true);
    expect(built).toBe(2);
    expect(be.startCalls).toBe(2);
  });
});

describe("SpotifyController.playTrack", () => {
  it("ensures started then delegates the uri, returning true", async () => {
    const { ctrl, be } = makeCtrl();
    expect(await ctrl.playTrack("spotify:track:abc")).toBe(true);
    expect(be.startCalls).toBe(1);
    expect(be.playCalls).toEqual(["spotify:track:abc"]);
  });
  it("returns false when the controller is unavailable", async () => {
    const { ctrl, be } = makeCtrl({ config: { enabled: false } });
    expect(await ctrl.playTrack("spotify:track:abc")).toBe(false);
    expect(be.playCalls).toEqual([]);
  });
  it("returns false when backend.playTrack rejects", async () => {
    const be = new FakeBackend();
    be.playShouldReject = true;
    const { ctrl } = makeCtrl({ backendFactory: () => be });
    expect(await ctrl.playTrack("spotify:track:abc")).toBe(false);
  });
});

describe("SpotifyController transport delegation", () => {
  it("pause/resume/seek forward to the backend after start", async () => {
    const { ctrl, be } = makeCtrl();
    await ctrl.ensureStarted();
    await ctrl.pause();
    await ctrl.resume();
    await ctrl.seek(4200);
    expect(be.pauseCalls).toBe(1);
    expect(be.resumeCalls).toBe(1);
    expect(be.seekCalls).toEqual([4200]);
  });
  it("pause/resume/seek are safe no-ops before start", async () => {
    const { ctrl, be } = makeCtrl();
    await expect(ctrl.pause()).resolves.toBeUndefined();
    await expect(ctrl.resume()).resolves.toBeUndefined();
    await expect(ctrl.seek(10)).resolves.toBeUndefined();
    expect(be.pauseCalls).toBe(0);
  });
  it("getPcmStream returns the backend stream", async () => {
    const { ctrl, be } = makeCtrl();
    await ctrl.ensureStarted();
    expect(ctrl.getPcmStream()).toBe(be.pcm);
  });
  it("getPcmStream throws before the backend is started", () => {
    const { ctrl } = makeCtrl();
    expect(() => ctrl.getPcmStream()).toThrow();
  });
});

describe("SpotifyController event re-emission", () => {
  it("re-emits backend trackEnded with the same payload", async () => {
    const { ctrl, be } = makeCtrl();
    await ctrl.ensureStarted();
    const got: SpotifyTrackEndedEvent[] = [];
    ctrl.on("trackEnded", (e) => got.push(e));
    const evt: SpotifyTrackEndedEvent = { uri: "spotify:track:x", reason: "ended" };
    be.emit("trackEnded", evt);
    expect(got).toEqual([evt]);
  });
  it("re-emits backend metadata with the same payload", async () => {
    const { ctrl, be } = makeCtrl();
    await ctrl.ensureStarted();
    const got: SpotifyNowPlaying[] = [];
    ctrl.on("metadata", (m) => got.push(m));
    const meta: SpotifyNowPlaying = {
      uri: "spotify:track:x",
      name: "Song",
      artist: "Artist",
      album: "Album",
      coverUrl: "http://img",
      durationMs: 1000,
    };
    be.emit("metadata", meta);
    expect(got).toEqual([meta]);
  });
});

describe("SpotifyController backend error handling (C3)", () => {
  it("does NOT throw on a backend 'error' with no controller listener, and marks not-ready", async () => {
    const be1 = new FakeBackend();
    const be2 = new FakeBackend();
    const backends = [be1, be2];
    let built = 0;
    const { ctrl } = makeCtrl({
      backendFactory: () => {
        built++;
        return backends.shift()!;
      },
    });
    await ctrl.ensureStarted();
    expect(built).toBe(1);
    // The controller itself has NO "error" listener. A raw re-emit would make
    // Node throw here; the controller must swallow+log instead.
    expect(() => be1.emit("error", new Error("sidecar boom"))).not.toThrow();
    // Marked not-ready: a fresh ensureStarted relaunches a new backend.
    expect(await ctrl.ensureStarted()).toBe(true);
    expect(built).toBe(2);
    expect(be2.startCalls).toBe(1);
  });

  it("tears down the errored backend (stop + detach + null) so it is not orphaned", async () => {
    const be1 = new FakeBackend();
    const be2 = new FakeBackend();
    const backends = [be1, be2];
    let built = 0;
    const { ctrl } = makeCtrl({
      backendFactory: () => {
        built++;
        return backends.shift()!;
      },
    });
    await ctrl.ensureStarted();
    expect(built).toBe(1);

    // On "error" the controller must stop() the errored backend (cleans its
    // ffmpeg/go-librespot children + FIFO) and detach ALL its listeners.
    expect(() => be1.emit("error", new Error("sidecar boom"))).not.toThrow();
    expect(be1.stopCalls).toBe(1);
    expect(be1.listenerCount("error")).toBe(0);
    expect(be1.listenerCount("trackEnded")).toBe(0);
    expect(be1.listenerCount("metadata")).toBe(0);

    // Internal backend is null: a transport call no-ops (delegates to nothing)
    // and getPcmStream throws until a rebuild.
    await ctrl.pause();
    expect(be1.pauseCalls).toBe(0);
    expect(() => ctrl.getPcmStream()).toThrow();

    // A fresh ensureStarted builds a NEW backend instance.
    expect(await ctrl.ensureStarted()).toBe(true);
    expect(built).toBe(2);
    expect(be2.startCalls).toBe(1);
    expect(ctrl.getPcmStream()).toBe(be2.pcm);
  });

  it("does not cross-talk: a later error from the ORPHANED backend leaves the healthy rebuilt controller ready", async () => {
    const be1 = new FakeBackend();
    const be2 = new FakeBackend();
    const backends = [be1, be2];
    let built = 0;
    const { ctrl } = makeCtrl({
      backendFactory: () => {
        built++;
        return backends.shift()!;
      },
    });
    await ctrl.ensureStarted();

    // First error tears down be1 and the controller rebuilds onto healthy be2.
    be1.emit("error", new Error("sidecar boom"));
    expect(await ctrl.ensureStarted()).toBe(true);
    expect(built).toBe(2);
    await ctrl.pause();
    expect(be2.pauseCalls).toBe(1);

    // A SECOND error emitted by the OLD (orphaned) backend must NOT reach the
    // controller: the healthy be2 stays owned, ready, and untouched.
    be1.on("error", () => {}); // controller detached; re-arm to avoid unhandled throw
    expect(() => be1.emit("error", new Error("orphan boom"))).not.toThrow();
    expect(be2.stopCalls).toBe(0); // healthy backend not torn down
    // Still ready: ensureStarted returns true without rebuilding a third time.
    expect(await ctrl.ensureStarted()).toBe(true);
    expect(built).toBe(2);
    await ctrl.pause();
    expect(be2.pauseCalls).toBe(2);
    expect(ctrl.getPcmStream()).toBe(be2.pcm);
  });
});

describe("SpotifyController.stop", () => {
  it("stops the backend and tears down state so a later start rebuilds", async () => {
    const be1 = new FakeBackend();
    const be2 = new FakeBackend();
    const backends = [be1, be2];
    const { ctrl } = makeCtrl({ backendFactory: () => backends.shift()! });
    await ctrl.ensureStarted();
    ctrl.stop();
    expect(be1.stopCalls).toBe(1);
    // After teardown getPcmStream is invalid again until re-started.
    expect(() => ctrl.getPcmStream()).toThrow();
    // A fresh ensureStarted builds a new backend.
    expect(await ctrl.ensureStarted()).toBe(true);
    expect(be2.startCalls).toBe(1);
  });
  it("stop before start is a safe no-op", () => {
    const { ctrl, be } = makeCtrl();
    expect(() => ctrl.stop()).not.toThrow();
    expect(be.stopCalls).toBe(0);
  });
});

describe("SpotifyController per-bot ports (Fix 3)", () => {
  it("threads apiPort + callbackPort into the default GoLibrespotBackend", async () => {
    goLibrespotCtor.mockClear();
    // No injected backendFactory → the controller builds the (mocked) real backend.
    const ctrl = new SpotifyController({
      config: cfg(),
      workDir: "/tmp/work",
      configDir: "/tmp/cfg",
      logger: silentLogger,
      apiPort: 3712,
      callbackPort: 8712,
    });
    expect(await ctrl.ensureStarted()).toBe(true);
    expect(goLibrespotCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiPort: 3712, callbackPort: 8712 }),
    );
  });
});
