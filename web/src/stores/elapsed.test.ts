import { describe, it, expect, vi, afterEach } from "vitest";
import { interpolateElapsed, type TimingState } from "./player.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function timing(partial: Partial<TimingState>): TimingState {
  return { serverElapsed: 0, serverSyncTime: 0, wasPlaying: false, ...partial };
}

describe("interpolateElapsed", () => {
  it("returns serverElapsed before playback has a sync anchor", () => {
    expect(interpolateElapsed(timing({ serverElapsed: 12, wasPlaying: false }), false, Infinity)).toBe(12);
    // wasPlaying but no sync time yet
    expect(interpolateElapsed(timing({ serverElapsed: 5, wasPlaying: true, serverSyncTime: 0 }), false, Infinity)).toBe(5);
  });

  it("advances with wall-clock time while playing (regression: must not be frozen)", () => {
    const spy = vi.spyOn(Date, "now");
    const t = timing({ serverElapsed: 30, serverSyncTime: 10_000, wasPlaying: true });

    spy.mockReturnValue(10_000);
    expect(interpolateElapsed(t, false, Infinity)).toBeCloseTo(30, 5);

    spy.mockReturnValue(11_000); // +1s
    expect(interpolateElapsed(t, false, Infinity)).toBeCloseTo(31, 5);

    spy.mockReturnValue(13_500); // +3.5s — distinct from the 1s reading
    expect(interpolateElapsed(t, false, Infinity)).toBeCloseTo(33.5, 5);
  });

  it("freezes at serverElapsed while paused", () => {
    vi.spyOn(Date, "now").mockReturnValue(99_000);
    const t = timing({ serverElapsed: 42, serverSyncTime: 10_000, wasPlaying: true });
    expect(interpolateElapsed(t, true, Infinity)).toBe(42);
  });

  it("clamps to maxDuration", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const t = timing({ serverElapsed: 100, serverSyncTime: 1_000, wasPlaying: true });
    expect(interpolateElapsed(t, false, 180)).toBe(180);
  });
});
