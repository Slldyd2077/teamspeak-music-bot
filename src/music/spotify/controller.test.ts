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
import type { SpotifyOAuth } from "./spotify-oauth.js";

// Controllable, hoisted so the vi.mock factory can close over it.
// go-* keys keep their Stage-2 names (`supported`/`path`) so existing tests are
// untouched; rust* keys drive the new librespot selection paths.
const bin = vi.hoisted(() => ({
  supported: true,
  path: "",
  rustSupported: true,
  rustPath: "",
}));
vi.mock("./binary.js", async () => {
  // existsSync mirrors the real resolveExecutable(find*()) result for the
  // bin/-style temp paths this suite uses (existingBin exists, missingBin does
  // not), keeping the chooseBackend/isAvailable matrix behavior-identical.
  const { existsSync } = await import("node:fs");
  return {
    isGoLibrespotSupported: () => bin.supported,
    findGoLibrespot: () => bin.path,
    resetGoLibrespotBinaryCache: () => {},
    checkGoLibrespotAvailable: async () => bin.supported && !!bin.path,
    isRustLibrespotSupported: () => bin.rustSupported,
    findLibrespot: () => bin.rustPath,
    resetLibrespotBinaryCache: () => {},
    checkLibrespotAvailable: async () => bin.rustSupported && !!bin.rustPath,
    // PATH-aware presence gates (Bug I3): supported gate AND the resolved
    // binary actually exists on disk.
    isGoLibrespotPresent: () => bin.supported && existsSync(bin.path),
    isLibrespotPresent: () => bin.rustSupported && existsSync(bin.rustPath),
  };
});

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
  bin.rustSupported = true;
  bin.rustPath = missingBin;
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
  /** When set, start() awaits this before resolving — lets a test interleave
   *  stop()/error DURING a mid-flight start (Bug I1). */
  startGate?: Promise<void>;
  readonly pcm = Readable.from([Buffer.alloc(0)]);

  async start(): Promise<void> {
    this.startCalls++;
    if (this.startGate) await this.startGate;
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
  oauth?: import("./spotify-oauth.js").SpotifyOAuth;
} = {}) {
  const be = new FakeBackend();
  const ctrl = new SpotifyController({
    config: cfg(over.config),
    workDir: "/tmp/work",
    configDir: "/tmp/cfg",
    logger: silentLogger,
    backendFactory: over.backendFactory ?? (() => be),
    oauth: over.oauth,
  });
  return { ctrl, be };
}

function fakeOAuth(
  authorized: boolean,
  hooks: { onIsAuthorized?: () => void } = {},
): SpotifyOAuth {
  return {
    isAuthorized: () => {
      hooks.onIsAuthorized?.();
      return authorized;
    },
    getAccessToken: async () => (authorized ? "tok" : null),
    getClientId: () => "cid",
    getRedirectUri: () => "http://127.0.0.1:5588/login",
    buildAuthorizeUrl: () => ({ url: "https://accounts.spotify.com/authorize", state: "s" }),
    handleCallback: async () => true,
  } as unknown as SpotifyOAuth;
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

  it("Bug I1: stop() DURING a mid-flight start tears the sidecar down instead of resurrecting it", async () => {
    // A Deferred the test resolves to complete backend.start() on demand.
    let resolveStart!: () => void;
    const startGate = new Promise<void>((res) => {
      resolveStart = res;
    });
    const be = new FakeBackend();
    be.startGate = startGate;
    const { ctrl } = makeCtrl({ backendFactory: () => be });

    // Kick off ensureStarted but DO NOT await — start() is parked on the gate.
    const startedP = ctrl.ensureStarted();
    // Let the ensureStarted IIFE run up to `await backend.start()`.
    await Promise.resolve();
    await Promise.resolve();
    expect(be.startCalls).toBe(1); // start() was entered and is now pending

    // Caller tears the controller down while start() is still in flight
    // (a user `!stop`/disconnect). Pre-fix this.backend is still null so this
    // is a no-op and the spawned sidecar is orphaned.
    ctrl.stop();

    // Now let start() finally resolve. Pre-fix the IIFE would set this.backend
    // and started=true, RESURRECTING the sidecar the caller already stopped.
    resolveStart();
    const result = await startedP;

    // Post-fix: the mid-flight backend is torn down, not promoted.
    expect(result).toBe(false);
    expect(be.stopCalls).toBeGreaterThanOrEqual(1); // the fake WAS stopped
    expect(be.listenerCount("trackEnded")).toBe(0); // listeners detached
    expect(() => ctrl.getPcmStream()).toThrow(); // not resurrected
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

describe("SpotifyController.chooseBackend (platform x config matrix)", () => {
  function pick(
    backend: SpotifyConfig["backend"],
    opts: { go: boolean; goSupported?: boolean; rust: boolean; rustSupported?: boolean },
  ) {
    bin.supported = opts.goSupported ?? true;
    bin.path = opts.go ? existingBin : missingBin;
    bin.rustSupported = opts.rustSupported ?? true;
    bin.rustPath = opts.rust ? existingBin : missingBin;
    const { ctrl } = makeCtrl({ config: { backend } });
    return ctrl.chooseBackend();
  }

  it("auto: prefers go-librespot when linux + go binary present", () => {
    expect(pick("auto", { go: true, rust: true })).toBe("go-librespot");
  });
  it("auto: falls back to librespot when go unsupported (e.g. Windows) but librespot present", () => {
    expect(pick("auto", { go: true, goSupported: false, rust: true })).toBe("librespot");
  });
  it("auto: falls back to librespot when go binary is absent", () => {
    expect(pick("auto", { go: false, rust: true })).toBe("librespot");
  });
  it("auto: null when neither backend is usable", () => {
    expect(pick("auto", { go: false, goSupported: false, rust: false })).toBeNull();
  });
  it("go-librespot: selected when supported + present", () => {
    expect(pick("go-librespot", { go: true, rust: true })).toBe("go-librespot");
  });
  it("go-librespot: null when unsupported, even if librespot is present", () => {
    expect(pick("go-librespot", { go: true, goSupported: false, rust: true })).toBeNull();
  });
  it("librespot: selected when the librespot binary is present", () => {
    expect(pick("librespot", { go: true, rust: true })).toBe("librespot");
  });
  it("librespot: null when the librespot binary is absent, even if go is present", () => {
    expect(pick("librespot", { go: true, rust: false })).toBeNull();
  });
});

describe("SpotifyController Rust-backend auth gate", () => {
  it("isAvailable is true for a present librespot binary regardless of auth", () => {
    bin.rustPath = existingBin;
    const { ctrl } = makeCtrl({
      config: { backend: "librespot" },
      oauth: fakeOAuth(false),
    });
    expect(ctrl.isAvailable()).toBe(true);
  });

  it("ensureStarted returns false (no backend built) when Rust chosen but unauthorized", async () => {
    bin.rustPath = existingBin;
    let built = 0;
    const { ctrl } = makeCtrl({
      config: { backend: "librespot" },
      oauth: fakeOAuth(false),
      backendFactory: () => {
        built++;
        return new FakeBackend();
      },
    });
    expect(await ctrl.ensureStarted()).toBe(false);
    expect(built).toBe(0);
  });

  it("ensureStarted starts the Rust backend once authorized", async () => {
    bin.rustPath = existingBin;
    const be = new FakeBackend();
    let built = 0;
    const { ctrl } = makeCtrl({
      config: { backend: "librespot" },
      oauth: fakeOAuth(true),
      backendFactory: () => {
        built++;
        return be;
      },
    });
    expect(await ctrl.ensureStarted()).toBe(true);
    expect(built).toBe(1);
    expect(be.startCalls).toBe(1);
  });

  it("go-librespot path never consults oauth.isAuthorized()", async () => {
    // auto + go present -> go-librespot; the auth gate must be skipped so a
    // throwing isAuthorized() is never reached.
    const oauth = fakeOAuth(false, {
      onIsAuthorized: () => {
        throw new Error("isAuthorized must not be called on the go path");
      },
    });
    const { ctrl } = makeCtrl({ config: { backend: "auto" }, oauth });
    expect(await ctrl.ensureStarted()).toBe(true);
  });

  it("exposes the shared oauth + connect instances", () => {
    const oauth = fakeOAuth(true);
    const { ctrl } = makeCtrl({ config: { backend: "auto" }, oauth });
    expect(ctrl.getOAuth()).toBe(oauth);
    expect(ctrl.getConnect()).toBeDefined();
  });
});
