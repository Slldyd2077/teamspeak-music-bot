import { describe, it, expect, vi } from "vitest";
import { BotInstance, COMMAND_DENIED_MESSAGE, spotifyPortsForBotId } from "./instance.js";
import type { TS3TextMessage } from "../ts-protocol/client.js";

// Constructing a real BotInstance is heavy (spawns a TS3Client, AudioPlayer,
// reads avatars, etc.), and runExclusive only touches a single private field
// (`playGate`). So we exercise the ACTUAL shipped method via its prototype,
// bound to a minimal object carrying just that field. This proves the real
// serializer logic without standing up a full bot.
type Gate = { playGate: Promise<unknown> };
const runExclusive = BotInstance.prototype.runExclusive as <T>(
  this: Gate,
  fn: () => Promise<T>,
) => Promise<T>;

function makeGate(): Gate {
  return { playGate: Promise.resolve() };
}

/** An explicit, timer-free deferred so ordering is deterministic. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BotInstance.runExclusive — serialization", () => {
  it("does not start fnB until fnA settles", async () => {
    const gate = makeGate();
    const order: string[] = [];
    const gateA = deferred();

    const pA = runExclusive.call(gate, async () => {
      order.push("A-start");
      await gateA.promise; // suspend A until we explicitly release it
      order.push("A-end");
    });

    const pB = runExclusive.call(gate, async () => {
      order.push("B-start");
      order.push("B-end");
    });

    // Give the microtask queue a chance: B must NOT have started while A is
    // still suspended on gateA.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["A-start"]);

    gateA.resolve();
    await pA;
    await pB;

    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  it("runs fnB even if fnA rejects (chain survives rejection)", async () => {
    const gate = makeGate();
    const order: string[] = [];
    const gateA = deferred();

    const pA = runExclusive.call(gate, async () => {
      order.push("A-start");
      await gateA.promise;
      throw new Error("A blew up");
    });

    const pB = runExclusive.call(gate, async () => {
      order.push("B-start");
      order.push("B-end");
      return "B-result";
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["A-start"]);

    gateA.reject(new Error("A blew up"));
    await expect(pA).rejects.toThrow("A blew up");

    // B still runs, only after A has fully settled.
    await expect(pB).resolves.toBe("B-result");
    expect(order).toEqual(["A-start", "B-start", "B-end"]);
  });

  it("preserves call order across three serialized tasks", async () => {
    const gate = makeGate();
    const order: string[] = [];
    const tasks = ["X", "Y", "Z"];
    const promises = tasks.map((t) =>
      runExclusive.call(gate, async () => {
        order.push(`${t}-start`);
        await Promise.resolve();
        order.push(`${t}-end`);
      }),
    );

    await Promise.all(promises);

    expect(order).toEqual([
      "X-start",
      "X-end",
      "Y-start",
      "Y-end",
      "Z-start",
      "Z-end",
    ]);
  });
});

/** Minimal `this` carrying only what handleTextMessage's gate path touches.
 *  The gate methods live on the prototype and are attached here so calls like
 *  `this.isCommandAllowed(...)` resolve against this same object. */
function makeGateCtx(opts: {
  adminGroups?: number[];
  lookupGroups?: string[];
  lookupThrows?: boolean;
}) {
  const ctx: any = {
    config: { commandPrefix: "!", commandAliases: {}, adminGroups: opts.adminGroups ?? [] },
    logger: { info: vi.fn(), error: vi.fn() },
    tsClient: {
      sendTextMessage: vi.fn(async () => {}),
      getClientServerGroups: vi.fn(async () => {
        if (opts.lookupThrows) throw new Error("query failed");
        return opts.lookupGroups ?? [];
      }),
    },
    executeCommand: vi.fn(async () => null),
    isCommandAllowed: (BotInstance.prototype as any).isCommandAllowed,
    lookupInvokerGroups: (BotInstance.prototype as any).lookupInvokerGroups,
  };
  return ctx;
}

function makeMsg(message: string, invokerGroups: string[] = [], invokerId = "5"): TS3TextMessage {
  return { invokerName: "Tester", invokerId, invokerUid: "uid", message, targetMode: 2, invokerGroups };
}

const handleTextMessage = (BotInstance.prototype as any).handleTextMessage as (
  this: unknown,
  msg: TS3TextMessage,
) => Promise<void>;

describe("BotInstance.handleTextMessage — command permission gate", () => {
  it("runs a public command with no group lookup, even under enforcement", async () => {
    const ctx = makeGateCtx({ adminGroups: [6] });
    await handleTextMessage.call(ctx, makeMsg("!play 晴天", ["6"]));
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
    expect(ctx.tsClient.getClientServerGroups).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).not.toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("runs an admin command with no lookup when enforcement is off", async () => {
    const ctx = makeGateCtx({ adminGroups: [] });
    await handleTextMessage.call(ctx, makeMsg("!stop"));
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
    expect(ctx.tsClient.getClientServerGroups).not.toHaveBeenCalled();
  });

  it("allows an enforced admin command when the live lookup returns a matching group", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupGroups: ["6"] });
    await handleTextMessage.call(ctx, makeMsg("!stop"));
    expect(ctx.tsClient.getClientServerGroups).toHaveBeenCalledTimes(1);
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("denies an enforced admin command when the live lookup has no matching group", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupGroups: ["8"] });
    await handleTextMessage.call(ctx, makeMsg("!stop"));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("fails closed when the live lookup returns no groups", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupGroups: [] });
    await handleTextMessage.call(ctx, makeMsg("!stop"));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("fails closed when the live lookup throws", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupThrows: true });
    await handleTextMessage.call(ctx, makeMsg("!stop"));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("ignores stale event groups: a demoted sender (cached match) is denied by the live lookup", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupGroups: ["8"] });
    await handleTextMessage.call(ctx, makeMsg("!stop", ["6"]));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("uses live groups, not stale event groups: a freshly-promoted sender is allowed", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupGroups: ["6"] });
    await handleTextMessage.call(ctx, makeMsg("!stop", ["8"]));
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("resolves out-of-channel senders server-wide: empty event groups but a matching live group → allowed", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupGroups: ["6"] });
    await handleTextMessage.call(ctx, makeMsg("!stop", [], "5"));
    expect(ctx.tsClient.getClientServerGroups).toHaveBeenCalledTimes(1);
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
  });
});

describe("BotInstance.getProviderFor — spotify routing", () => {
  it("getProviderFor routes 'spotify' to the injected spotify provider", () => {
    const spotify = { platform: "spotify" } as any;
    const ctx = { spotifyProvider: spotify, neteaseProvider: { platform: "netease" } } as any;
    expect(BotInstance.prototype.getProviderFor.call(ctx, "spotify" as any)).toBe(spotify);
  });
});

// --- Spotify orchestration (Task 7 + Correction C4) ------------------------
// These drive the REAL prototype methods on a hand-built ctx (the file's
// established `.call(ctx)` style) and assert the routing DECISIONS. Live audio
// is not testable here. C4 supersedes the brief where they conflict: switching
// a URL track -> spotify does NOT call player.stop() (playPcmStream fences the
// prior ffmpeg internally), and a spotify -> spotify handoff does NOT re-attach
// the persistent PCM stream (playPcmStream is called ONCE across both tracks).

const resolveAndPlay = BotInstance.prototype.resolveAndPlay as (
  this: unknown,
  song: any,
) => Promise<boolean>;
const setupPlayerEvents = (BotInstance.prototype as any).setupPlayerEvents as (
  this: unknown,
) => void;
const cmdPause = (BotInstance.prototype as any).cmdPause as (this: unknown) => string;
const cmdResume = (BotInstance.prototype as any).cmdResume as (this: unknown) => string;
const cmdStop = (BotInstance.prototype as any).cmdStop as (this: unknown) => string;
const handleOccupancy = (BotInstance.prototype as any).handleOccupancy as (
  this: unknown,
  userCount: number,
) => void;
const seek = (BotInstance.prototype as any).seek as (this: unknown, seconds: number) => void;

function makeController() {
  return {
    ensureStarted: vi.fn(async () => true),
    playTrack: vi.fn(async () => true),
    getPcmStream: vi.fn(() => ({ kind: "pcm" } as any)),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
    on: vi.fn(),
  };
}
function makePlayer() {
  // `externalActive` mirrors the real AudioPlayer: playPcmStream attaches the
  // external stream (true), and both stop() and play() detach it (false). The
  // re-attach guard reads isExternalActive(), so this must track that state.
  let externalActive = false;
  return {
    play: vi.fn((..._args: any[]) => { externalActive = false; }),
    stop: vi.fn(() => { externalActive = false; }),
    playPcmStream: vi.fn((..._args: any[]) => { externalActive = true; }),
    pause: vi.fn(),
    resume: vi.fn(),
    seek: vi.fn(),
    isExternalActive: vi.fn(() => externalActive),
  };
}
function makeResolveCtx(opts: {
  controller: ReturnType<typeof makeController>;
  player: ReturnType<typeof makePlayer>;
  url: string;
  currentSourceIsSpotify?: boolean;
}) {
  return {
    connected: true,
    config: {},
    id: "bot1",
    voteSkipUsers: new Set<string>(),
    autoPaused: false,
    currentSourceIsSpotify: opts.currentSourceIsSpotify ?? false,
    effectiveDuration: undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tsClient: { sendTextMessage: vi.fn(async () => {}) },
    database: { addPlayHistory: vi.fn() },
    spotifyController: opts.controller,
    player: opts.player,
    getProviderFor: vi.fn(() => ({ getSongUrl: async () => ({ url: opts.url }) })),
    syncProfileToSong: vi.fn(async () => {}),
    emit: vi.fn(),
  } as any;
}
function spotifySong() {
  return {
    id: "abc",
    name: "Song",
    artist: "Artist",
    album: "Album",
    platform: "spotify",
    coverUrl: "c",
    duration: 200,
    url: "",
  };
}

describe("BotInstance.resolveAndPlay — Spotify routing (C4)", () => {
  it("routes a spotify song to controller.playTrack + player.playPcmStream, not player.play", async () => {
    const controller = makeController();
    const player = makePlayer();
    const ctx = makeResolveCtx({ controller, player, url: "spotify:track:abc" });

    const ok = await resolveAndPlay.call(ctx, spotifySong());

    expect(ok).toBe(true);
    expect(controller.ensureStarted).toHaveBeenCalledTimes(1);
    expect(controller.playTrack).toHaveBeenCalledWith("spotify:track:abc");
    expect(player.playPcmStream).toHaveBeenCalledTimes(1);
    expect(player.playPcmStream.mock.calls[0][0]).toEqual({ kind: "pcm" });
    expect(player.play).not.toHaveBeenCalled();
    // C4: playPcmStream fences the prior url-ffmpeg internally — no player.stop().
    expect(player.stop).not.toHaveBeenCalled();
    expect(ctx.currentSourceIsSpotify).toBe(true);
    expect(ctx.database.addPlayHistory).toHaveBeenCalledTimes(1);
    expect(ctx.emit).toHaveBeenCalledWith("stateChange");
  });

  it("returns false + sends the Stage-1 fallback when the backend is unavailable", async () => {
    const controller = makeController();
    controller.ensureStarted = vi.fn(async () => false);
    const player = makePlayer();
    const ctx = makeResolveCtx({ controller, player, url: "spotify:track:abc" });

    const ok = await resolveAndPlay.call(ctx, spotifySong());

    expect(ok).toBe(false);
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(controller.playTrack).not.toHaveBeenCalled();
    expect(player.playPcmStream).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
  });

  it("attaches the PCM stream once (no player.stop) when switching URL -> spotify", async () => {
    const controller = makeController();
    const player = makePlayer();
    const ctx = makeResolveCtx({
      controller, player, url: "spotify:track:abc", currentSourceIsSpotify: false,
    });

    await resolveAndPlay.call(ctx, spotifySong());

    // C4: NO player.stop() on the URL -> spotify transition.
    expect(player.stop).not.toHaveBeenCalled();
    expect(player.playPcmStream).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-attach the stream on a spotify -> spotify handoff (playPcmStream called once across two tracks)", async () => {
    const controller = makeController();
    const player = makePlayer();
    const ctx = makeResolveCtx({
      controller, player, url: "spotify:track:abc", currentSourceIsSpotify: false,
    });

    // First spotify track: coming from a URL/idle source -> attach.
    await resolveAndPlay.call(ctx, spotifySong());
    expect(ctx.currentSourceIsSpotify).toBe(true);
    // Second spotify track: go-librespot changes tracks into the SAME FIFO.
    await resolveAndPlay.call(ctx, spotifySong());

    expect(player.playPcmStream).toHaveBeenCalledTimes(1); // NOT re-attached
    expect(controller.playTrack).toHaveBeenCalledTimes(2); // both tracks played
    expect(player.stop).not.toHaveBeenCalled();
  });

  it("RE-attaches on a spotify -> (command player.stop) -> spotify sequence (does not stay silent)", async () => {
    // Regression: command paths (cmdPlay/cmdPlaylist/cmdAlbum/cmdFm) call
    // player.stop() — which DETACHES the external stream — WITHOUT clearing the
    // currentSourceIsSpotify flag. Gating re-attach on the stale flag skipped
    // playPcmStream, silencing the next spotify track. We now gate on the
    // player's actual external state, so the re-attach happens.
    const controller = makeController();
    const player = makePlayer();
    const ctx = makeResolveCtx({
      controller, player, url: "spotify:track:abc", currentSourceIsSpotify: false,
    });

    // First spotify track attaches the persistent PCM stream.
    await resolveAndPlay.call(ctx, spotifySong());
    expect(player.playPcmStream).toHaveBeenCalledTimes(1);
    expect(player.isExternalActive()).toBe(true);

    // A command path stops the player (detaches the stream) but leaves the
    // spotify flag stale-true — exactly the state that used to cause silence.
    player.stop();
    expect(player.isExternalActive()).toBe(false);
    expect(ctx.currentSourceIsSpotify).toBe(true); // flag NOT cleared by stop()

    // Next spotify track MUST re-attach (gate on player external state, not flag).
    await resolveAndPlay.call(ctx, spotifySong());
    expect(player.playPcmStream).toHaveBeenCalledTimes(2);
    expect(player.isExternalActive()).toBe(true);
  });

  it("returns false + sends the fallback when playTrack resolves false (dead/failed sidecar)", async () => {
    const controller = makeController();
    controller.playTrack = vi.fn(async () => false);
    const player = makePlayer();
    const ctx = makeResolveCtx({ controller, player, url: "spotify:track:abc" });

    const ok = await resolveAndPlay.call(ctx, spotifySong());

    expect(ok).toBe(false);
    expect(controller.playTrack).toHaveBeenCalledTimes(1);
    // Same Stage-1 fallback message as the backend-unavailable path.
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledTimes(1);
    // Never attach the player to a dead stream.
    expect(player.playPcmStream).not.toHaveBeenCalled();
    expect(ctx.currentSourceIsSpotify).toBe(false);
  });

  it("recovers on mid-session sidecar death: onExternalEnd stops controller+player and clears the flag", async () => {
    const controller = makeController();
    const player = makePlayer();
    const ctx = makeResolveCtx({ controller, player, url: "spotify:track:abc" });

    await resolveAndPlay.call(ctx, spotifySong());
    expect(ctx.currentSourceIsSpotify).toBe(true);
    expect(player.playPcmStream).toHaveBeenCalledTimes(1);

    // The sidecar PCM stream EOFs mid-session → fire the wired onExternalEnd.
    const opts = player.playPcmStream.mock.calls[0][1] as { onExternalEnd?: () => void };
    expect(typeof opts.onExternalEnd).toBe("function");
    opts.onExternalEnd!();

    // Recovery: controller torn down (next track rebuilds), player stopped
    // (drops external mode so the next track re-attaches), flag cleared.
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(player.stop).toHaveBeenCalledTimes(1);
    expect(ctx.currentSourceIsSpotify).toBe(false);
  });

  it("pauses the sidecar and clears the flag when switching to a non-spotify track", async () => {
    const controller = makeController();
    const player = makePlayer();
    const song = { ...spotifySong(), platform: "netease" };
    const ctx = makeResolveCtx({
      controller, player, url: "http://cdn/x.mp3", currentSourceIsSpotify: true,
    });

    const ok = await resolveAndPlay.call(ctx, song);

    expect(ok).toBe(true);
    expect(controller.pause).toHaveBeenCalledTimes(1);
    expect(ctx.currentSourceIsSpotify).toBe(false);
    expect(player.play).toHaveBeenCalledWith("http://cdn/x.mp3", 0, 200);
    expect(player.playPcmStream).not.toHaveBeenCalled();
  });
});

describe("BotInstance.setupPlayerEvents — controller trackEnded wiring", () => {
  function makeEventCtx(currentPlatform: string) {
    return {
      spotifyController: { on: vi.fn() },
      player: { on: vi.fn() },
      queue: { current: vi.fn(() => ({ platform: currentPlatform })) },
      logger: { debug: vi.fn(), error: vi.fn() },
      playNext: vi.fn(async () => true),
    } as any;
  }
  function trackEndedHandler(ctx: any) {
    const call = ctx.spotifyController.on.mock.calls.find(
      (c: any[]) => c[0] === "trackEnded",
    );
    expect(call).toBeDefined();
    return call[1] as (e: any) => void;
  }

  it("advances via playNext when the current song is spotify", () => {
    const ctx = makeEventCtx("spotify");
    setupPlayerEvents.call(ctx);
    trackEndedHandler(ctx)({ uri: "spotify:track:x", reason: "ended" });
    expect(ctx.playNext).toHaveBeenCalledTimes(1);
  });

  it("ignores controller trackEnded when the current song is not spotify", () => {
    const ctx = makeEventCtx("netease");
    setupPlayerEvents.call(ctx);
    trackEndedHandler(ctx)({ uri: "spotify:track:x", reason: "ended" });
    expect(ctx.playNext).not.toHaveBeenCalled();
  });
});

describe("BotInstance transport delegation — spotify current song", () => {
  function makeCmdCtx(currentPlatform: string) {
    return {
      player: { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() },
      spotifyController: {
        pause: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
        stop: vi.fn(() => {}),
      },
      queue: { current: vi.fn(() => ({ platform: currentPlatform })), clear: vi.fn() },
      logger: { warn: vi.fn() },
      emit: vi.fn(),
      autoPaused: true,
      currentSourceIsSpotify: true,
      sweepLocalAudio: vi.fn(),
      disableFmMode: vi.fn(),
      profileManager: { onSongChange: vi.fn(async () => {}) },
    } as any;
  }

  it("cmdPause delegates to controller.pause when current is spotify", () => {
    const ctx = makeCmdCtx("spotify");
    cmdPause.call(ctx);
    expect(ctx.player.pause).toHaveBeenCalled();
    expect(ctx.spotifyController.pause).toHaveBeenCalledTimes(1);
  });

  it("cmdResume delegates to controller.resume when current is spotify", () => {
    const ctx = makeCmdCtx("spotify");
    cmdResume.call(ctx);
    expect(ctx.player.resume).toHaveBeenCalled();
    expect(ctx.spotifyController.resume).toHaveBeenCalledTimes(1);
  });

  it("cmdStop stops the sidecar + player and clears the spotify flag", () => {
    const ctx = makeCmdCtx("spotify");
    cmdStop.call(ctx);
    expect(ctx.spotifyController.stop).toHaveBeenCalledTimes(1);
    expect(ctx.player.stop).toHaveBeenCalledTimes(1);
    expect(ctx.queue.clear).toHaveBeenCalledTimes(1);
    expect(ctx.currentSourceIsSpotify).toBe(false);
  });

  it("does NOT touch the controller when current is not spotify", () => {
    const ctx = makeCmdCtx("netease");
    cmdPause.call(ctx);
    cmdResume.call(ctx);
    expect(ctx.spotifyController.pause).not.toHaveBeenCalled();
    expect(ctx.spotifyController.resume).not.toHaveBeenCalled();
  });
});

describe("BotInstance.handleOccupancy — spotify auto-pause delegation (C4)", () => {
  function makeOccupancyCtx(currentPlatform: string, state: string) {
    return {
      player: { getState: () => state, pause: vi.fn(), resume: vi.fn() },
      spotifyController: { pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) },
      queue: { current: vi.fn(() => ({ platform: currentPlatform })) },
      config: { autoPauseOnEmpty: true },
      autoPaused: false,
      logger: { warn: vi.fn() },
      emit: vi.fn(),
      _scheduleIdleCheck: vi.fn(),
      _cancelIdleTimer: vi.fn(),
    } as any;
  }

  it("delegates pause to the controller when auto-pausing a spotify track (empty channel)", () => {
    const ctx = makeOccupancyCtx("spotify", "playing");
    handleOccupancy.call(ctx, 0);
    expect(ctx.player.pause).toHaveBeenCalledTimes(1);
    expect(ctx.spotifyController.pause).toHaveBeenCalledTimes(1);
    expect(ctx.autoPaused).toBe(true);
  });

  it("delegates resume to the controller when a listener returns to a spotify track", () => {
    const ctx = makeOccupancyCtx("spotify", "paused");
    ctx.autoPaused = true;
    handleOccupancy.call(ctx, 1);
    expect(ctx.player.resume).toHaveBeenCalledTimes(1);
    expect(ctx.spotifyController.resume).toHaveBeenCalledTimes(1);
    expect(ctx.autoPaused).toBe(false);
  });

  it("does NOT touch the controller when auto-pausing a non-spotify track", () => {
    const ctx = makeOccupancyCtx("netease", "playing");
    handleOccupancy.call(ctx, 0);
    expect(ctx.player.pause).toHaveBeenCalledTimes(1);
    expect(ctx.spotifyController.pause).not.toHaveBeenCalled();
  });
});

describe("BotInstance.seek — spotify routing (C4)", () => {
  function makeSeekCtx(currentPlatform: string) {
    return {
      queue: { current: vi.fn(() => ({ platform: currentPlatform })) },
      spotifyController: { seek: vi.fn(async () => {}) },
      player: { seek: vi.fn() },
      logger: { warn: vi.fn() },
    } as any;
  }

  it("routes seek to the controller for a spotify track, converting seconds -> ms", () => {
    const ctx = makeSeekCtx("spotify");
    seek.call(ctx, 30); // 30 seconds
    // SpotifyController.seek is millisecond-based: 30s -> 30000ms (not 30).
    expect(ctx.spotifyController.seek).toHaveBeenCalledWith(30000);
    expect(ctx.player.seek).not.toHaveBeenCalled();
  });

  it("routes seek to the player (seconds-based) for a non-spotify track", () => {
    const ctx = makeSeekCtx("netease");
    seek.call(ctx, 30);
    expect(ctx.player.seek).toHaveBeenCalledWith(30);
    expect(ctx.spotifyController.seek).not.toHaveBeenCalled();
  });
});

describe("spotifyPortsForBotId — per-bot go-librespot ports (Fix 3)", () => {
  it("yields the SAME ports for the same bot id (stable across restarts)", () => {
    const a = spotifyPortsForBotId("bot-alpha");
    const b = spotifyPortsForBotId("bot-alpha");
    expect(a).toEqual(b);
  });

  it("yields DIFFERENT ports for different bot ids", () => {
    const a = spotifyPortsForBotId("bot-alpha");
    const b = spotifyPortsForBotId("bot-beta");
    expect(a.apiPort).not.toBe(b.apiPort);
    expect(a.callbackPort).not.toBe(b.callbackPort);
  });

  it("keeps apiPort and callbackPort in disjoint ranges", () => {
    for (const id of ["bot-alpha", "bot-beta", "x", "a-very-long-bot-identifier-123"]) {
      const { apiPort, callbackPort } = spotifyPortsForBotId(id);
      expect(apiPort).toBeGreaterThanOrEqual(3700);
      expect(apiPort).toBeLessThan(4700);
      expect(callbackPort).toBeGreaterThanOrEqual(8700);
      expect(callbackPort).toBeLessThan(9700);
      // Same offset within each range → the two never collide with each other.
      expect(callbackPort - apiPort).toBe(5000);
    }
  });
});
