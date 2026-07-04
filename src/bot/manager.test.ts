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
import type { SpotifyOAuth } from "../music/spotify/spotify-oauth.js";

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

// --- Spotify OAuth threading (Task 6, C3.1) --------------------------------
// The single process-wide SpotifyOAuth built in index.ts must reach every bot's
// SpotifyController: index -> BotManager (trailing positional arg) -> BotInstance
// -> controller. createBot() builds a REAL (side-effect-free) SpotifyController,
// so we assert the shared instance surfaces via the controller's getOAuth().
describe("BotManager — spotifyOAuth threading to bot controllers (C3.1)", () => {
  const dirs: string[] = [];
  let db: BotDatabase | undefined;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    db = undefined;
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("forwards its shared SpotifyOAuth into a created bot's controller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsmusicbot-oauth-thread-"));
    dirs.push(dir);
    const configPath = join(dir, "config.json");
    const config = getDefaultConfig();
    saveConfig(configPath, config);
    db = createDatabase(":memory:");
    const permissions = createPermissionStore(db.db);
    const provider = {} as unknown as MusicProvider;
    const sentinel = {} as unknown as SpotifyOAuth;

    const manager = new BotManager(
      provider,
      provider,
      provider,
      db,
      config,
      stubLogger,
      {} as unknown as AvatarStore,
      permissions,
      configPath,
      undefined, // localProvider
      undefined, // kugouProvider
      undefined, // spotifyProvider
      join(dir, "spotify"), // spotifyDataDir
      sentinel, // spotifyOAuth (the single shared instance)
    );

    const bot = await manager.createBot({
      name: "b1",
      serverAddress: "localhost",
      serverPort: 9987,
      nickname: "b1",
    });

    // Full chain observed: the manager's single shared instance is the exact
    // one the per-bot controller now owns (getOAuth() returns it unchanged).
    expect(bot.getSpotifyController().getOAuth()).toBe(sentinel);

    bot.disconnect();
  });
});
