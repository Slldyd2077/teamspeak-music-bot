import { describe, it, expect, vi } from "vitest";
import { authorize } from "./authorize.js";

function run(user: any, opts: any) {
  const req: any = { user };
  const res: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
  const next = vi.fn();
  authorize(opts)(req, res, next);
  return { res, next };
}

describe("authorize", () => {
  it("401 when unauthenticated", () => {
    const { res, next } = run(undefined, { capability: "player.queue" });
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it("admin always passes", () => {
    const { next } = run({ role: "admin" }, { capability: "bot.manage" });
    expect(next).toHaveBeenCalled();
  });
  it("member passes only with the capability", () => {
    expect(run({ role: "member", capabilities: new Set(["player.queue"]) }, { capability: "player.queue" }).next).toHaveBeenCalled();
    expect(run({ role: "member", capabilities: new Set() }, { capability: "player.queue" }).res.statusCode).toBe(403);
  });
  it("guest passes only when its flag is enabled", () => {
    expect(run({ role: "guest", guest: { playNext: true } }, { capability: "player.control", guestFlag: "playNext" }).next).toHaveBeenCalled();
    expect(run({ role: "guest", guest: { playNext: false } }, { capability: "player.control", guestFlag: "playNext" }).res.statusCode).toBe(403);
  });
  it("guest is denied on routes with no guestFlag (e.g. play-song)", () => {
    expect(run({ role: "guest", guest: { addToQueue: true } }, { capability: "player.control" }).res.statusCode).toBe(403);
  });
  it("guest with a non-boolean truthy flag value (1) is denied (strict-boolean gate)", () => {
    expect(run({ role: "guest", guest: { playNext: 1 } as any }, { guestFlag: "playNext" }).res.statusCode).toBe(403);
    expect(run({ role: "guest", guest: { playNext: true } }, { guestFlag: "playNext" }).next).toHaveBeenCalled();
  });
});
