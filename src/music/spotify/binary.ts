import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter } from "node:path";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a command to an existing absolute path, SYNCHRONOUSLY. A candidate
 * that already contains a path separator (a project bin/ path) is checked
 * directly; a BARE command name (e.g. "librespot" / "go-librespot") is searched
 * across the $PATH directories — with PATHEXT extensions appended on win32 — so
 * a scoop/choco/cargo/apt PATH install resolves. Returns the resolved path, or
 * null when nothing exists.
 *
 * This is the sync counterpart to checkLibrespotAvailable()/…GoLibrespot… and
 * is what the hot-path presence gates (chooseBackend/isAvailable) rely on: a
 * bare name must NOT be handed to existsSync() directly, since existsSync
 * resolves it against process.cwd() rather than PATH (Bug I3/m1).
 */
export function resolveExecutable(cmd: string): string | null {
  if (cmd.includes("/") || cmd.includes("\\")) {
    return existsSync(cmd) ? cmd : null;
  }
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const hasExt = ext && cmd.toLowerCase().endsWith(ext.toLowerCase());
      const full = join(dir, hasExt ? cmd : cmd + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

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

/**
 * SYNCHRONOUS presence gate for go-librespot: supported platform (linux) AND
 * the resolved binary (project bin/ OR a PATH install) actually exists. This is
 * what chooseBackend()/isAvailable() must use — NOT existsSync(findGoLibrespot())
 * which cannot see a bare PATH name (Bug I3/m1).
 */
export function isGoLibrespotPresent(): boolean {
  return isGoLibrespotSupported() && resolveExecutable(findGoLibrespot()) !== null;
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

// ---------------------------------------------------------------------------
// Rust librespot (librespot-org) resolver — mirrors the go-librespot fns
// above. Unlike go-librespot, Rust librespot's `--backend pipe` writes PCM to
// *stdout* on every platform (no FIFO, no audio device), so it is supported
// on Windows/macOS/Linux alike and the binary is named librespot.exe on win32.
// ---------------------------------------------------------------------------

/**
 * True on ALL platforms. The Rust librespot pipe backend writes raw bytes to
 * process stdout, which Node's spawned child.stdout receives unmodified on
 * Windows too — so there is no platform gate here (contrast
 * isGoLibrespotSupported, which is Linux-only).
 */
export function isRustLibrespotSupported(): boolean {
  return true;
}

/**
 * Pure resolver core behind findLibrespot(). Returns the first candidate that
 * is either a bare command name (left for execFile to resolve via PATH) or an
 * existing bin/ file. Exported so tests can inject candidates + a fake
 * existence predicate and need no real binary on disk. Mirrors
 * pickGoLibrespotPath but keys off the win32 exe name.
 */
export function pickLibrespotPath(
  candidates: string[],
  exists: (p: string) => boolean,
): string {
  const exe = process.platform === "win32" ? "librespot.exe" : "librespot";
  for (const c of candidates) {
    // bin/ paths only count when the file is actually present; bare names are
    // returned unconditionally and resolved later via PATH.
    const isBinPath = c.includes(join("bin", "librespot"));
    if (!isBinPath || exists(c)) return c;
  }
  return exe;
}

/**
 * Resolve the Rust librespot binary path: project bin/ dir first, then PATH.
 * On win32 both the bin/librespot.exe candidate and the bare "librespot.exe"
 * fallback are used so a PATH-installed librespot.exe (scoop/choco) resolves.
 */
export function findLibrespot(): string {
  const exe = process.platform === "win32" ? "librespot.exe" : "librespot";
  // src/music/spotify -> ../../../bin (same depth as findGoLibrespot).
  const binExe = join(__dirname, "..", "..", "..", "bin", exe);
  const binBare = join(__dirname, "..", "..", "..", "bin", "librespot");
  return pickLibrespotPath([binExe, binBare, exe], existsSync);
}

/**
 * SYNCHRONOUS presence gate for Rust librespot: supported everywhere AND the
 * resolved binary (project bin/ OR a scoop/choco/cargo PATH install) actually
 * exists. This is what chooseBackend()/isAvailable() must use — NOT
 * existsSync(findLibrespot()) which cannot see a bare PATH name (Bug I3/m1).
 */
export function isLibrespotPresent(): boolean {
  return isRustLibrespotSupported() && resolveExecutable(findLibrespot()) !== null;
}

// Injectable `--version` probe. Defaults to the real execFile call; tests
// override it so checkLibrespotAvailable() needs no real binary. Keeps the
// public checkLibrespotAvailable() signature param-free per the contract.
type LibrespotVersionProbe = (bin: string) => Promise<void>;
const realLibrespotProbe: LibrespotVersionProbe = async (bin) => {
  await execFileAsync(bin, ["--version"], { timeout: 5_000, maxBuffer: 1024 });
};
let librespotVersionProbe: LibrespotVersionProbe = realLibrespotProbe;

/** Test hook: override the `--version` probe, or restore the default with null. */
export function __setLibrespotVersionProbe(
  probe: LibrespotVersionProbe | null,
): void {
  librespotVersionProbe = probe ?? realLibrespotProbe;
}

/**
 * Availability check for Rust librespot. No platform gate (supported
 * everywhere). Runs `librespot --version` (5s timeout) and caches ONLY the
 * positive result — a missing binary is retried on the next call so the
 * operator can install it (cargo/scoop/choco) without restarting the server.
 */
let rustCachedAvailable = false;
let rustPendingCheck: Promise<boolean> | null = null;
export async function checkLibrespotAvailable(): Promise<boolean> {
  if (!isRustLibrespotSupported()) return false;
  if (rustCachedAvailable) return true;
  if (rustPendingCheck) return rustPendingCheck;
  rustPendingCheck = (async () => {
    try {
      await librespotVersionProbe(findLibrespot());
      rustCachedAvailable = true;
      return true;
    } catch {
      return false;
    } finally {
      rustPendingCheck = null;
    }
  })();
  return rustPendingCheck;
}

/** Force re-detection on the next call (for tests). */
export function resetLibrespotBinaryCache(): void {
  rustCachedAvailable = false;
  rustPendingCheck = null;
}
