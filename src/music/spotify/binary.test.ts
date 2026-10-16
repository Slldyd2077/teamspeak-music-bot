import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  isGoLibrespotSupported,
  pickGoLibrespotPath,
  findGoLibrespot,
  checkGoLibrespotAvailable,
  resetGoLibrespotBinaryCache,
  __setGoLibrespotVersionProbe,
  isRustLibrespotSupported,
  pickLibrespotPath,
  findLibrespot,
  checkLibrespotAvailable,
  resetLibrespotBinaryCache,
  __setLibrespotVersionProbe,
  resolveExecutable,
  isLibrespotPresent,
  isGoLibrespotPresent,
} from "./binary.js";

const origPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

// Snapshot the PATH env so PATH-resolution tests can point it at temp dirs and
// restore afterwards. PATHEXT is optional (undefined on posix); track presence.
const origPath = process.env.PATH;
const origPathExt = process.env.PATHEXT;
const tmpDirs: string[] = [];
function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  setPlatform(origPlatform);
  __setGoLibrespotVersionProbe(null);
  resetGoLibrespotBinaryCache();
  __setLibrespotVersionProbe(null);
  resetLibrespotBinaryCache();
  process.env.PATH = origPath;
  if (origPathExt === undefined) delete process.env.PATHEXT;
  else process.env.PATHEXT = origPathExt;
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("isGoLibrespotSupported", () => {
  it("is true only on linux", () => {
    setPlatform("linux");
    expect(isGoLibrespotSupported()).toBe(true);
    setPlatform("win32");
    expect(isGoLibrespotSupported()).toBe(false);
    setPlatform("darwin");
    expect(isGoLibrespotSupported()).toBe(false);
  });
});

describe("pickGoLibrespotPath (bin/ then PATH ordering)", () => {
  const binPath = join("some", "root", "bin", "go-librespot");

  it("prefers the bin/ path when the file exists", () => {
    expect(
      pickGoLibrespotPath([binPath, "go-librespot"], (p) => p === binPath),
    ).toBe(binPath);
  });

  it("falls through to the bare PATH name when the bin/ file is missing", () => {
    expect(pickGoLibrespotPath([binPath, "go-librespot"], () => false)).toBe(
      "go-librespot",
    );
  });

  it("returns bare command names without touching the filesystem", () => {
    const exists = vi.fn(() => false);
    expect(pickGoLibrespotPath(["go-librespot"], exists)).toBe("go-librespot");
    expect(exists).not.toHaveBeenCalled();
  });
});

describe("findGoLibrespot", () => {
  it("returns the bare command name when bin/go-librespot is absent", () => {
    // No go-librespot binary is committed under bin/, so resolution must
    // fall back to the bare PATH name (execFile resolves it at run time).
    expect(findGoLibrespot()).toBe("go-librespot");
  });
});

describe("checkGoLibrespotAvailable", () => {
  it("returns false immediately on unsupported platforms without probing", async () => {
    setPlatform("darwin");
    const probe = vi.fn(async () => {});
    __setGoLibrespotVersionProbe(probe);
    expect(await checkGoLibrespotAvailable()).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true when the binary responds to --version on linux", async () => {
    setPlatform("linux");
    __setGoLibrespotVersionProbe(async () => {});
    expect(await checkGoLibrespotAvailable()).toBe(true);
  });

  it("caches only positive results and probes once", async () => {
    setPlatform("linux");
    const probe = vi.fn(async () => {});
    __setGoLibrespotVersionProbe(probe);
    expect(await checkGoLibrespotAvailable()).toBe(true);
    expect(await checkGoLibrespotAvailable()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed probe (retries on the next call)", async () => {
    setPlatform("linux");
    __setGoLibrespotVersionProbe(async () => {
      throw new Error("ENOENT");
    });
    expect(await checkGoLibrespotAvailable()).toBe(false);
    // A later successful probe must now succeed — negatives are not cached.
    __setGoLibrespotVersionProbe(async () => {});
    expect(await checkGoLibrespotAvailable()).toBe(true);
  });

  it("resetGoLibrespotBinaryCache clears a cached positive", async () => {
    setPlatform("linux");
    __setGoLibrespotVersionProbe(async () => {});
    expect(await checkGoLibrespotAvailable()).toBe(true);
    resetGoLibrespotBinaryCache();
    __setGoLibrespotVersionProbe(async () => {
      throw new Error("gone");
    });
    expect(await checkGoLibrespotAvailable()).toBe(false);
  });
});

describe("isRustLibrespotSupported", () => {
  it("is true on every platform (pipe->stdout works everywhere)", () => {
    setPlatform("linux");
    expect(isRustLibrespotSupported()).toBe(true);
    setPlatform("win32");
    expect(isRustLibrespotSupported()).toBe(true);
    setPlatform("darwin");
    expect(isRustLibrespotSupported()).toBe(true);
  });
});

describe("pickLibrespotPath (bin/ then PATH ordering, win32 exe)", () => {
  it("prefers the bin/ path when the file exists", () => {
    const binPath = join("some", "root", "bin", "librespot");
    expect(
      pickLibrespotPath([binPath, "librespot"], (p) => p === binPath),
    ).toBe(binPath);
  });

  it("prefers the bin/librespot.exe path on win32 when it exists", () => {
    setPlatform("win32");
    const binExe = join("some", "root", "bin", "librespot.exe");
    expect(
      pickLibrespotPath([binExe, "librespot.exe"], (p) => p === binExe),
    ).toBe(binExe);
  });

  it("falls through to the bare PATH name (librespot) on posix when bin/ is missing", () => {
    setPlatform("linux");
    const binPath = join("some", "root", "bin", "librespot");
    expect(pickLibrespotPath([binPath, "librespot"], () => false)).toBe(
      "librespot",
    );
  });

  it("falls through to librespot.exe on win32 when bin/ is missing", () => {
    setPlatform("win32");
    const binExe = join("some", "root", "bin", "librespot.exe");
    expect(pickLibrespotPath([binExe], () => false)).toBe("librespot.exe");
  });

  it("returns bare command names without touching the filesystem", () => {
    const exists = vi.fn(() => false);
    expect(pickLibrespotPath(["librespot"], exists)).toBe("librespot");
    expect(exists).not.toHaveBeenCalled();
  });
});

describe("findLibrespot", () => {
  it("returns the bare command name when bin/librespot is absent", () => {
    // No librespot binary is committed under bin/, so resolution must fall
    // back to the bare PATH name (execFile resolves it at run time).
    setPlatform("linux");
    expect(findLibrespot()).toBe("librespot");
  });

  it("returns librespot.exe on win32 when bin/librespot.exe is absent", () => {
    setPlatform("win32");
    expect(findLibrespot()).toBe("librespot.exe");
  });
});

describe("checkLibrespotAvailable", () => {
  it("returns true when the binary responds to --version (any platform)", async () => {
    setPlatform("win32");
    __setLibrespotVersionProbe(async () => {});
    expect(await checkLibrespotAvailable()).toBe(true);
  });

  it("returns true on darwin too (no platform gate)", async () => {
    setPlatform("darwin");
    __setLibrespotVersionProbe(async () => {});
    expect(await checkLibrespotAvailable()).toBe(true);
  });

  it("caches only positive results and probes once", async () => {
    setPlatform("linux");
    const probe = vi.fn(async () => {});
    __setLibrespotVersionProbe(probe);
    expect(await checkLibrespotAvailable()).toBe(true);
    expect(await checkLibrespotAvailable()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed probe (retries on the next call)", async () => {
    setPlatform("win32");
    __setLibrespotVersionProbe(async () => {
      throw new Error("ENOENT");
    });
    expect(await checkLibrespotAvailable()).toBe(false);
    __setLibrespotVersionProbe(async () => {});
    expect(await checkLibrespotAvailable()).toBe(true);
  });

  it("resetLibrespotBinaryCache clears a cached positive", async () => {
    setPlatform("linux");
    __setLibrespotVersionProbe(async () => {});
    expect(await checkLibrespotAvailable()).toBe(true);
    resetLibrespotBinaryCache();
    __setLibrespotVersionProbe(async () => {
      throw new Error("gone");
    });
    expect(await checkLibrespotAvailable()).toBe(false);
  });

  it("de-dupes concurrent in-flight probes", async () => {
    setPlatform("linux");
    const probe = vi.fn(async () => {});
    __setLibrespotVersionProbe(probe);
    const [a, b] = await Promise.all([
      checkLibrespotAvailable(),
      checkLibrespotAvailable(),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("resolveExecutable", () => {
  it("returns a bin/-style path (contains a separator) that exists, unchanged", () => {
    const dir = mkTmpDir("tsmb-resolve-");
    const full = join(dir, "some-binary");
    writeFileSync(full, "#!/bin/sh\n");
    // The path contains a separator so it is checked directly, not via PATH.
    expect(resolveExecutable(full)).toBe(full);
  });

  it("returns null for a bin/-style path that does not exist", () => {
    const full = join(tmpdir(), "tsmb-resolve-missing", "nope-binary");
    expect(resolveExecutable(full)).toBeNull();
  });

  it("resolves a BARE command name found in a PATH directory (the I3 fix)", () => {
    // This is the regression the fix targets: a PATH-installed binary (bare
    // name, no separator) must resolve against $PATH, not process.cwd().
    const dir = mkTmpDir("tsmb-resolve-path-");
    const exeName = process.platform === "win32" ? "faketool.exe" : "faketool";
    const full = join(dir, exeName);
    writeFileSync(full, "#!/bin/sh\n");
    process.env.PATH = dir;
    expect(resolveExecutable(exeName)).toBe(full);
  });

  it("returns null for a bare name not present in any PATH directory", () => {
    process.env.PATH = mkTmpDir("tsmb-resolve-empty-");
    expect(resolveExecutable("definitely-not-a-real-binary-xyz")).toBeNull();
  });

  it("appends PATHEXT extensions on win32 to resolve a bare (extensionless) name", () => {
    setPlatform("win32");
    const dir = mkTmpDir("tsmb-resolve-pathext-");
    const full = join(dir, "mytool.CMD");
    writeFileSync(full, "@echo hi\n");
    process.env.PATH = dir;
    process.env.PATHEXT = ".EXE;.CMD;.BAT;.COM";
    // Bare "mytool" has no extension; win32 resolution must try PATHEXT and
    // find mytool.CMD.
    expect(resolveExecutable("mytool")).toBe(full);
  });

  it("does not touch PATH for a bin/-style relative path with a separator", () => {
    // A candidate with a separator is checked directly even if PATH is empty.
    process.env.PATH = "";
    const dir = mkTmpDir("tsmb-resolve-direct-");
    const full = join(dir, "direct-binary");
    writeFileSync(full, "#!/bin/sh\n");
    expect(resolveExecutable(full)).toBe(full);
  });
});

describe("isLibrespotPresent (PATH-aware, sync)", () => {
  it("true when the bare librespot name resolves on PATH (posix)", () => {
    setPlatform("linux");
    const dir = mkTmpDir("tsmb-librespot-path-");
    writeFileSync(join(dir, "librespot"), "#!/bin/sh\n");
    process.env.PATH = dir;
    expect(isLibrespotPresent()).toBe(true);
  });

  it("true when librespot.exe resolves on PATH (win32)", () => {
    setPlatform("win32");
    const dir = mkTmpDir("tsmb-librespot-win-");
    writeFileSync(join(dir, "librespot.exe"), "MZ\n");
    process.env.PATH = dir;
    process.env.PATHEXT = ".EXE;.CMD;.BAT;.COM";
    expect(isLibrespotPresent()).toBe(true);
  });

  it("false when librespot is not on PATH", () => {
    setPlatform("linux");
    process.env.PATH = mkTmpDir("tsmb-librespot-empty-");
    expect(isLibrespotPresent()).toBe(false);
  });
});

describe("isGoLibrespotPresent (PATH-aware, sync)", () => {
  it("true when go-librespot resolves on PATH (linux)", () => {
    setPlatform("linux");
    const dir = mkTmpDir("tsmb-go-path-");
    writeFileSync(join(dir, "go-librespot"), "#!/bin/sh\n");
    process.env.PATH = dir;
    expect(isGoLibrespotPresent()).toBe(true);
  });

  it("false on non-linux platforms regardless of PATH (unsupported gate)", () => {
    setPlatform("win32");
    const dir = mkTmpDir("tsmb-go-win-");
    writeFileSync(join(dir, "go-librespot"), "#!/bin/sh\n");
    process.env.PATH = dir;
    expect(isGoLibrespotPresent()).toBe(false);
  });

  it("false on linux when go-librespot is not on PATH", () => {
    setPlatform("linux");
    process.env.PATH = mkTmpDir("tsmb-go-empty-");
    expect(isGoLibrespotPresent()).toBe(false);
  });
});
