import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { BotManager } from "./manager.js";
import { createDatabase, type BotDatabase } from "../data/database.js";
import { createPermissionStore } from "../data/permissions.js";
import { getDefaultConfig, loadConfig, saveConfig, type BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";
import type { MusicProvider } from "../music/provider.js";
import type { AvatarStore } from "../data/avatars.js";

// removeBot only calls logger.info; provide the full shape it could touch.
const stubLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return stubLogger;
  },
} as unknown as Logger;

describe("BotManager.removeBot — guest scope pruning", () => {
  const dirs: string[] = [];
  let db: BotDatabase;

  function makeTmpConfigPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "tsmusicbot-manager-test-"));
    dirs.push(dir);
    return join(dir, "config.json");
  }

  function makeManager(config: BotConfig, configPath: string): BotManager {
    db = createDatabase(":memory:");
    const permissions = createPermissionStore(db.db);
    saveConfig(configPath, config);
    return new BotManager(
      {} as unknown as MusicProvider,
      {} as unknown as MusicProvider,
      {} as unknown as MusicProvider,
      db,
      config,
      stubLogger,
      {} as unknown as AvatarStore,
      permissions,
      configPath
    );
  }

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("prunes a deleted bot from guestMode.bots (array) and persists", async () => {
    const configPath = makeTmpConfigPath();
    const config = getDefaultConfig();
    config.guestMode.bots = ["botA", "botB"];
    const manager = makeManager(config, configPath);

    await manager.removeBot("botA");

    expect(config.guestMode.bots).toEqual(["botB"]);
    // Persisted file must also reflect the prune.
    expect(loadConfig(configPath).guestMode.bots).toEqual(["botB"]);
  });

  it('leaves guestMode.bots === "all" unchanged (no crash, no change)', async () => {
    const configPath = makeTmpConfigPath();
    const config = getDefaultConfig();
    config.guestMode.bots = "all";
    const manager = makeManager(config, configPath);

    await manager.removeBot("botA");

    expect(config.guestMode.bots).toBe("all");
    expect(loadConfig(configPath).guestMode.bots).toBe("all");
  });
});
