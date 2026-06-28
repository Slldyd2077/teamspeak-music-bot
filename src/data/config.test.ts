import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getDefaultConfig, loadConfig, saveConfig, migrateLegacyConfig } from "./config.js";

describe("config", () => {
  const dirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "tsmusicbot-test-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("returns default config when file does not exist", () => {
    const config = loadConfig("/nonexistent/path/config.json");
    expect(config).toEqual(getDefaultConfig());
  });

  it("creates config file on save", () => {
    const dir = makeTmpDir();
    const path = join(dir, "sub", "config.json");
    const config = getDefaultConfig();
    saveConfig(path, config);

    const loaded = loadConfig(path);
    expect(loaded).toEqual(config);
  });

  it("merges partial config with defaults", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");

    // Save a partial config by writing only some fields
    const partial = { webPort: 8080, locale: "en" };
    writeFileSync(path, JSON.stringify(partial), "utf-8");

    const loaded = loadConfig(path);
    expect(loaded.webPort).toBe(8080);
    expect(loaded.locale).toBe("en");
    // defaults should fill in the rest
    expect(loaded.theme).toBe("dark");
    expect(loaded.commandPrefix).toBe("!");
    // auto-pause defaults OFF (occupancy detection is unreliable on some servers)
    expect(loaded.autoPauseOnEmpty).toBe(false);
  });

  // --- #86: config.json must live under (and be created in) the persisted data dir ---

  it("first run writes config.json into the data dir and reads it back", () => {
    const root = makeTmpDir();
    const dataDir = join(root, "data");
    const configPath = join(dataDir, "config.json"); // mirrors index.ts CONFIG_PATH

    // Boot sequence: load (missing -> defaults) then save.
    const config = loadConfig(configPath);
    saveConfig(configPath, config);

    expect(existsSync(configPath)).toBe(true);
    // A subsequent hand-edited file under the SAME persisted path is honored.
    writeFileSync(configPath, JSON.stringify({ webPort: 9999 }), "utf-8");
    expect(loadConfig(configPath).webPort).toBe(9999);
  });

  it("migrates a legacy root config into the data dir, preserving values", () => {
    const root = makeTmpDir();
    const legacyPath = join(root, "config.json");
    const newPath = join(root, "data", "config.json");
    writeFileSync(legacyPath, JSON.stringify({ webPort: 4242, publicUrl: "http://x" }), "utf-8");

    const migrated = migrateLegacyConfig(legacyPath, newPath);

    expect(migrated).toBe(true);
    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(false); // legacy moved, not duplicated
    const loaded = loadConfig(newPath);
    expect(loaded.webPort).toBe(4242);
    expect(loaded.publicUrl).toBe("http://x");
  });

  it("does NOT overwrite an existing data-dir config during migration", () => {
    const root = makeTmpDir();
    const legacyPath = join(root, "config.json");
    const newPath = join(root, "data", "config.json");
    writeFileSync(legacyPath, JSON.stringify({ webPort: 1111 }), "utf-8");
    saveConfig(newPath, { ...getDefaultConfig(), webPort: 2222 });

    const migrated = migrateLegacyConfig(legacyPath, newPath);

    expect(migrated).toBe(false); // new location wins, untouched
    expect(loadConfig(newPath).webPort).toBe(2222);
    expect(existsSync(legacyPath)).toBe(true); // legacy left intact when not migrated
  });

  it("migration is a no-op when there is no legacy config", () => {
    const root = makeTmpDir();
    const migrated = migrateLegacyConfig(join(root, "config.json"), join(root, "data", "config.json"));
    expect(migrated).toBe(false);
  });
});

describe("guestMode config", () => {
  it("defaults to disabled, all-bots, append-only", () => {
    const c = getDefaultConfig();
    expect(c.guestMode.enabled).toBe(false);
    expect(c.guestMode.bots).toBe("all");
    expect(c.guestMode.permissions).toEqual({
      addToQueue: true, playNext: false, playNow: false,
      skip: false, transport: false, removeClear: false, playMode: false,
    });
  });

  it("deep-merges a partial guestMode so missing sub-keys are back-filled", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsmb-cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ guestMode: { enabled: true, permissions: { playNext: true } } }));
    const c = loadConfig(p);
    expect(c.guestMode.enabled).toBe(true);
    expect(c.guestMode.bots).toBe("all"); // back-filled
    expect(c.guestMode.permissions.playNext).toBe(true);
    expect(c.guestMode.permissions.addToQueue).toBe(true); // back-filled default
    expect(c.guestMode.permissions.skip).toBe(false); // back-filled default
    rmSync(dir, { recursive: true, force: true });
  });

  // --- B1: loadConfig must sanitize a hand-edited/legacy/corrupt guestMode ---

  function loadGuestMode(raw: unknown) {
    const dir = mkdtempSync(join(tmpdir(), "tsmb-cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify(raw));
    try {
      return loadConfig(p).guestMode;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  describe("bots normalization", () => {
    it("a numeric bots value falls back to the default \"all\" (no crash)", () => {
      const gm = loadGuestMode({ guestMode: { bots: 5 } });
      expect(gm.bots).toBe("all");
    });
    it("an array bots value is filtered to strings only", () => {
      const gm = loadGuestMode({ guestMode: { bots: ["a", 2, "b"] } });
      expect(gm.bots).toEqual(["a", "b"]);
    });
    it("the literal \"all\" is preserved", () => {
      const gm = loadGuestMode({ guestMode: { bots: "all" } });
      expect(gm.bots).toBe("all");
    });
  });

  describe("permissions coercion", () => {
    it("a non-boolean truthy flag is coerced to false; a real true stays true", () => {
      const gm = loadGuestMode({ guestMode: { permissions: { skip: 1, playNext: true } } });
      expect(gm.permissions.skip).toBe(false);
      expect(gm.permissions.playNext).toBe(true);
    });
    it("a string permissions value yields defaults with no numeric index keys", () => {
      const gm = loadGuestMode({ guestMode: { permissions: "hacked" } });
      // 7 known flags present at their defaults
      expect(gm.permissions).toEqual({
        addToQueue: true, playNext: false, playNow: false,
        skip: false, transport: false, removeClear: false, playMode: false,
      });
      // no garbage index keys leaked from spreading a string
      expect((gm.permissions as unknown as Record<string, unknown>)["0"]).toBeUndefined();
    });
  });
});
