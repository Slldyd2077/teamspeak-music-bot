import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, migrateLegacyConfig } from "./data/config.js";
import { createDatabase } from "./data/database.js";
import { createLogger } from "./logger.js";
import { createApiServerManager } from "./music/api-server.js";
import { createCookieStore } from "./music/auth.js";
import { createAvatarStore } from "./data/avatars.js";
import { createPermissionStore } from "./data/permissions.js";
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
const STATIC_DIR = path.join(ROOT_DIR, "web", "dist");

/**
 * 一次性迁移：旧版全局 cookie（{cookieDir}/{platform}.json）搬到第一个 bot 名下
 * （{cookieDir}/{botId}/{platform}.json），兼容单租户历史数据。仅在旧文件存在
 * 且目标不存在时移动，幂等。必须在 loadSavedBots（createProviders 读 cookie）之前跑。
 */
function migrateLegacyCookies(db: { getBotInstances(): { id: string }[] }, cookieDir: string, logger: { info(...args: unknown[]): void }): void {
  const instances = db.getBotInstances();
  if (instances.length === 0) return;
  const firstBotId = instances[0].id;
  for (const platform of ["netease", "qq", "bilibili"]) {
    const oldPath = path.join(cookieDir, `${platform}.json`);
    const newDir = path.join(cookieDir, firstBotId);
    const newPath = path.join(newDir, `${platform}.json`);
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      fs.mkdirSync(newDir, { recursive: true });
      fs.renameSync(oldPath, newPath);
      logger.info({ platform, botId: firstBotId }, "Migrated legacy global cookie to bot");
    }
  }
}

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

  const botManager = new BotManager(
    cookieStore,
    apiServer.getNeteaseBaseUrl(),
    apiServer.getQQMusicBaseUrl(),
    db,
    config,
    logger,
    avatarStore,
    permissions,
    CONFIG_PATH
  );
  // 一次性迁移：旧全局 cookie（{platform}.json）→ 第一个 bot（兼容单租户历史数据）
  migrateLegacyCookies(db, COOKIE_DIR, logger);
  await botManager.loadSavedBots();

  const webServer = createWebServer({
    port: config.webPort,
    botManager,
    neteaseBaseUrl: apiServer.getNeteaseBaseUrl(),
    qqBaseUrl: apiServer.getQQMusicBaseUrl(),
    database: db,
    avatarStore,
    config,
    configPath: CONFIG_PATH,
    logger,
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
