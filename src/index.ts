import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, migrateLegacyConfig } from "./data/config.js";
import { createDatabase } from "./data/database.js";
import { createLogger } from "./logger.js";
import { createApiServerManager } from "./music/api-server.js";
import { createCookieStore } from "./music/auth.js";
import { createAvatarStore } from "./data/avatars.js";
import { createPermissionStore } from "./data/permissions.js";
import { createProviderFactory } from "./bot/provider-factory.js";
import { BotManager } from "./bot/manager.js";
import { createWebServer } from "./web/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
// config.json lives under the persisted data dir (the Docker volume) alongside the
// DB/cookies/logs, so it survives container restarts and manual edits take effect
// (#86). LEGACY_CONFIG_PATH is the old root-level location we migrate from once.
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LEGACY_CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const DB_PATH = path.join(DATA_DIR, "tsmusicbot.db");
const LOG_DIR = path.join(DATA_DIR, "logs");
const COOKIE_DIR = path.join(DATA_DIR, "cookies");
const AVATAR_DIR = path.join(DATA_DIR, "avatars");
const LOCAL_AUDIO_DIR = path.join(DATA_DIR, "local-audio");
const STATIC_DIR = path.join(ROOT_DIR, "web", "dist");

async function main() {
  // Migrate a pre-#86 root-level config.json into the data dir so existing
  // installs keep their settings; no-op if already migrated or none exists.
  migrateLegacyConfig(LEGACY_CONFIG_PATH, CONFIG_PATH);
  const config = loadConfig(CONFIG_PATH);
  saveConfig(CONFIG_PATH, config);

  const logger = createLogger(LOG_DIR);

  // Prevent unhandled errors from crashing the process
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });
  const db = createDatabase(DB_PATH);

  const apiServer = createApiServerManager(
    { neteasePort: config.neteaseApiPort, qqMusicPort: config.qqMusicApiPort },
    logger
  );
  await apiServer.start();

  const cookieStore = createCookieStore(COOKIE_DIR);
  const avatarStore = createAvatarStore(AVATAR_DIR);
  const permissions = createPermissionStore(db.db);

  const providerFactory = createProviderFactory({
    neteaseBaseUrl: apiServer.getNeteaseBaseUrl(),
    qqMusicBaseUrl: apiServer.getQQMusicBaseUrl(),
    localAudioDir: LOCAL_AUDIO_DIR,
  });

  // Per-bot platform cookies: each bot loads its own saved cookie when
  // constructed (BotManager.buildProvidersFor). No global startup load.
  const botManager = new BotManager(
    providerFactory,
    cookieStore,
    db,
    config,
    logger,
    avatarStore,
    permissions,
    CONFIG_PATH,
  );
  await botManager.loadSavedBots();

  const webServer = createWebServer({
    port: config.webPort,
    botManager,
    database: db,
    avatarStore,
    config,
    configPath: CONFIG_PATH,
    logger,
    cookieStore,
    staticDir: STATIC_DIR,
  });
  await webServer.start();

  logger.info({ webPort: config.webPort }, "TSMusicBot started");
  const publicUrl = (config.publicUrl ?? "").trim().replace(/\/+$/, "");
  logger.info(
    `WebUI: ${publicUrl || `http://localhost:${config.webPort}`}`
  );

  const shutdown = () => {
    logger.info("Shutting down...");
    botManager.shutdown();
    webServer.stop();
    apiServer.stop();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
