export type PlayerStateName = "idle" | "playing" | "paused";
export type OccupancyAction = "pause" | "resume" | "none";

/**
 * Decide what auto-pause should do given channel occupancy.
 * - empty (userCount <= 0): pause iff enabled and currently playing.
 * - re-populated (userCount > 0): resume iff we previously auto-paused and are still paused.
 * `autoPaused` distinguishes our auto-pause from a user pause, so user pauses are never resumed.
 */
export function decideOccupancyAction(
  playerState: PlayerStateName,
  autoPaused: boolean,
  enabled: boolean,
  userCount: number,
): OccupancyAction {
  const empty = userCount <= 0;
  if (empty) {
    if (enabled && playerState === "playing") return "pause";
    return "none";
  }
  if (autoPaused && playerState === "paused") return "resume";
  return "none";
}
