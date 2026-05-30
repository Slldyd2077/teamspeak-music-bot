import { describe, it, expect } from "vitest";
import { resolveScopedBot } from "./scope.js";

describe("resolveScopedBot", () => {
  it("returns null when no id requested", () => {
    expect(resolveScopedBot(null, ["a", "b"])).toBeNull();
    expect(resolveScopedBot(undefined, ["a"])).toBeNull();
    expect(resolveScopedBot("", ["a"])).toBeNull();
  });
  it("returns the id when it exists in the bot list", () => {
    expect(resolveScopedBot("b", ["a", "b"])).toBe("b");
  });
  it("clears (null) when the requested id is not a known bot", () => {
    expect(resolveScopedBot("ghost", ["a", "b"])).toBeNull();
  });
});
