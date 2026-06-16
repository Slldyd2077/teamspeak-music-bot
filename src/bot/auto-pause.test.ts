import { describe, it, expect } from "vitest";
import { decideOccupancyAction, occupancyFromClientList } from "./auto-pause.js";

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

describe("occupancyFromClientList", () => {
  it("returns null when the query failed (0 clients — bot itself is always present)", () => {
    // This is the bug fix: a clientlist timeout makes getClientsInChannel()
    // return [], which must be treated as "unknown", NOT as an empty channel.
    expect(occupancyFromClientList(0)).toBeNull();
  });
  it("returns 0 other users when only the bot is in the channel", () => {
    expect(occupancyFromClientList(1)).toBe(0);
  });
  it("excludes the bot itself from the count", () => {
    expect(occupancyFromClientList(2)).toBe(1);
    expect(occupancyFromClientList(5)).toBe(4);
  });
  it("never yields a negative count (guards the -1 that caused false pauses)", () => {
    expect(occupancyFromClientList(-3)).toBeNull();
  });
});
