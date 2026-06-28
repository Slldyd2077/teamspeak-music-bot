import { describe, it, expect, vi } from "vitest";
import { requireNotGuest } from "./requireNotGuest.js";

function run(user: any) {
  const req: any = { user };
  const res: any = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
  const next = vi.fn();
  requireNotGuest(req, res, next);
  return { res, next };
}

describe("requireNotGuest", () => {
  it("401 when no user", () => { expect(run(undefined).res.statusCode).toBe(401); });
  it("403 for guests", () => { expect(run({ role: "guest" }).res.statusCode).toBe(403); });
  it("passes admins and members", () => {
    expect(run({ role: "admin" }).next).toHaveBeenCalled();
    expect(run({ role: "member" }).next).toHaveBeenCalled();
  });
});
