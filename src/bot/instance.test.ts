import { describe, it, expect } from "vitest";
import { BotInstance } from "./instance.js";

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
