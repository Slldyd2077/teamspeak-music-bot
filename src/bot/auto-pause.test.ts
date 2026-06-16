import { describe, it, expect } from "vitest";
import { decideOccupancyAction } from "./auto-pause.js";

describe("decideOccupancyAction", () => {
  it("pauses when empty while playing and enabled", () => {
    expect(decideOccupancyAction("playing", false, true, 0)).toBe("pause");
  });
  it("does not pause when the feature is disabled", () => {
    expect(decideOccupancyAction("playing", false, false, 0)).toBe("none");
  });
  it("does not pause when idle (nothing playing)", () => {
    expect(decideOccupancyAction("idle", false, true, 0)).toBe("none");
  });
  it("does not pause when already paused", () => {
    expect(decideOccupancyAction("paused", false, true, 0)).toBe("none");
  });
  it("resumes when re-populated and we auto-paused", () => {
    expect(decideOccupancyAction("paused", true, true, 2)).toBe("resume");
  });
  it("does NOT resume a user-paused track on re-population", () => {
    expect(decideOccupancyAction("paused", false, true, 2)).toBe("none");
  });
  it("does nothing when re-populated and already playing", () => {
    expect(decideOccupancyAction("playing", false, true, 2)).toBe("none");
  });
  it("resume is independent of the enabled flag (we already auto-paused)", () => {
    expect(decideOccupancyAction("paused", true, false, 1)).toBe("resume");
  });
});
