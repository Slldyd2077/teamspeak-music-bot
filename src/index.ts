import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, migrateLegacyConfig, isProviderEnabled } from "./data/config.js";
import { createDatabase } from "./data/database.js";
import { createLogger } from "./logger.js";
import { createApiServerManager } from "./music/api-server.js";
import { SpotifyProvider } from "./music/spotify/provider.js";
import { SpotifyOAuth, createFileOAuthTokenStore } from "./music/spotify/spotify-oauth.js";
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
const SPOTIFY_DATA_DIR = path.join(DATA_DIR, "spotify");
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
    {
      neteasePort: config.neteaseApiPort,
      qqMusicPort: config.qqMusicApiPort,
      // Provider gating: a sidecar only starts (and binds 3001/3200) when its
      // source is listed in enabledProviders — both are on in the default config.
      neteaseEnabled: isProviderEnabled(config, "netease"),
      qqEnabled: isProviderEnabled(config, "qq"),
    },
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

  // Spotify safety gate (spec §7): the metadata source stays inert unless
  // EXPLICITLY enabled. Only feed credentials when enabled — otherwise the
  // shared provider has no creds, hasCreds() is false, search returns empty,
  // and getAuthStatus() is loggedIn:false, so setting a Client ID/Secret
  // alone (enabled:false) never activates Spotify.
  if (config.spotify.enabled && config.spotify.clientId) {
    (providerFactory.spotifyProvider as SpotifyProvider).setCreds(
      config.spotify.clientId,
      config.spotify.clientSecret,
    );
  }

  // Single process-wide Spotify authorization (one Premium account for Stage 3).
  // Threaded into BOTH the web OAuth router and every bot's SpotifyController so
  // a web login immediately authorizes playback (C3.1). Own-app clientId => the
  // redirect points at this bot's web callback; empty clientId leaves OAuth
  // disabled (isAuthorized() stays false and the Rust backend never starts).
  const spotifyOAuthClientId = config.spotify.clientId.trim();
  const spotifyOAuth = new SpotifyOAuth({
    clientId: spotifyOAuthClientId || undefined,
    redirectUri: spotifyOAuthClientId
      ? `http://127.0.0.1:${config.webPort}/api/spotify/callback`
      : undefined,
    store: createFileOAuthTokenStore(
      path.join(SPOTIFY_DATA_DIR, "oauth", "oauth-tokens.json"),
    ),
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
    SPOTIFY_DATA_DIR,
    spotifyOAuth
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
    spotifyOAuth,
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
