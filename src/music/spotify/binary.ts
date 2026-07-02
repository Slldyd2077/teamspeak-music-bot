import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * True only on Linux. go-librespot ships Linux-only release binaries and the
 * sidecar relies on a POSIX FIFO (mkfifo), so the Spotify audio backend is
 * gated to Linux/Docker. Everywhere else the caller falls back to the Stage-1
 * sentinel-skip message.
 */
export function isGoLibrespotSupported(): boolean {
  return process.platform === "linux";
}

/**
 * Pure resolver core behind findGoLibrespot(). Returns the first candidate
 * that is either a bare command name (left for execFile to resolve via PATH)
 * or an existing bin/ file. Exported so tests can inject candidates + a fake
 * existence predicate and need no real binary on disk.
 */
export function pickGoLibrespotPath(
  candidates: string[],
  exists: (p: string) => boolean,
): string {
  for (const c of candidates) {
    // bin/ paths only count when the file is actually present; bare names are
    // returned unconditionally and resolved later via PATH.
    const isBinPath = c.includes(join("bin", "go-librespot"));
    if (!isBinPath || exists(c)) return c;
  }
  return "go-librespot";
}

/** Resolve the go-librespot binary path: project bin/ dir first, then PATH. */
export function findGoLibrespot(): string {
  // src/music/spotify -> ../../../bin (one level deeper than youtube.ts).
  const binPath = join(__dirname, "..", "..", "..", "bin", "go-librespot");
  return pickGoLibrespotPath([binPath, "go-librespot"], existsSync);
}

// Injectable `--version` probe. Defaults to the real execFile call; tests
// override it so checkGoLibrespotAvailable() needs no real binary. Keeps the
// public checkGoLibrespotAvailable() signature param-free per the contract.
type VersionProbe = (bin: string) => Promise<void>;
const realProbe: VersionProbe = async (bin) => {
  await execFileAsync(bin, ["--version"], { timeout: 5_000, maxBuffer: 1024 });
};
let versionProbe: VersionProbe = realProbe;

/** Test hook: override the `--version` probe, or restore the default with null. */
export function __setGoLibrespotVersionProbe(
  probe: VersionProbe | null,
): void {
  versionProbe = probe ?? realProbe;
}

/**
 * Availability check for go-librespot. Returns false immediately on non-Linux
 * platforms (unsupported). Otherwise runs `go-librespot --version` (5s timeout)
 * and caches ONLY the positive result — a missing binary is retried on the
 * next call so the operator can install it without restarting the server.
 */
let cachedAvailable = false;
let pendingCheck: Promise<boolean> | null = null;
export async function checkGoLibrespotAvailable(): Promise<boolean> {
  if (!isGoLibrespotSupported()) return false;
  if (cachedAvailable) return true;
  if (pendingCheck) return pendingCheck;
  pendingCheck = (async () => {
    try {
      await versionProbe(findGoLibrespot());
      cachedAvailable = true;
      return true;
    } catch {
      return false;
    } finally {
      pendingCheck = null;
    }
  })();
  return pendingCheck;
}

/** Force re-detection on the next call (for tests). */
export function resetGoLibrespotBinaryCache(): void {
  cachedAvailable = false;
  pendingCheck = null;
}
