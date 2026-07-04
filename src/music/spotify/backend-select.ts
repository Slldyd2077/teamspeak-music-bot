/** Which concrete backend runs for a given config + host binary availability. */
export type SpotifyBackendKind = "go-librespot" | "librespot";

/**
 * Pure backend selection shared by SpotifyController.chooseBackend() (per-bot)
 * and the web /status endpoint (process-wide). Booleans in, no IO — the caller
 * supplies platform+binary presence.
 */
export function resolveSpotifyBackendKind(
  backend: "auto" | "go-librespot" | "librespot",
  goPresent: boolean,
  rustPresent: boolean,
): SpotifyBackendKind | null {
  switch (backend) {
    case "go-librespot":
      return goPresent ? "go-librespot" : null;
    case "librespot":
      return rustPresent ? "librespot" : null;
    case "auto":
    default:
      if (goPresent) return "go-librespot";
      if (rustPresent) return "librespot";
      return null;
  }
}
