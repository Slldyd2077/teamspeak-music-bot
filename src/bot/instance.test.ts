import { describe, it, expect, vi } from "vitest";
import { BotInstance, COMMAND_DENIED_MESSAGE } from "./instance.js";
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
