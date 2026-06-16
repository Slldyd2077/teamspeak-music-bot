import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export interface BotConfig {
  webPort: number;
  locale: "zh" | "en";
  theme: "dark" | "light";
  commandPrefix: string;
  commandAliases: Record<string, string>;
  neteaseApiPort: number;
  qqMusicApiPort: number;
  adminPassword: string;
  adminGroups: number[];
  autoReturnDelay: number;
  autoPauseOnEmpty: boolean;
  idleTimeoutMinutes: number;
  // Public base URL used when generating share links (e.g. the bot专属链接).
  // Leave empty to use the browser's current origin. Example:
  //   "https://music.example.com" or "http://1.2.3.4:3000"
  publicUrl: string;
  // When true, Express trusts X-Forwarded-* headers from a reverse proxy
  // (nginx/Caddy/Cloudflare). Required for correct protocol/host detection
  // behind HTTPS-terminating proxies.
  trustProxy: boolean;
}

export function getDefaultConfig(): BotConfig {
  return {
    webPort: 3000,
    locale: "zh",
    theme: "dark",
    commandPrefix: "!",
    commandAliases: { p: "play", s: "skip", n: "next" },
    neteaseApiPort: 3001,
    qqMusicApiPort: 3200,
    adminPassword: "",
    adminGroups: [],
    autoReturnDelay: 300,
    // Default OFF: occupancy detection relies on the full-client `clientlist`
    // command, which is unreliable on some servers (it can time out when other
    // clients are present). Users can opt in from the web UI.
    autoPauseOnEmpty: false,
    idleTimeoutMinutes: 0,
    publicUrl: "",
    trustProxy: false,
  };
}

export function loadConfig(path: string): BotConfig {
  const defaults = getDefaultConfig();
  try {
    const raw = readFileSync(path, "utf-8");
    const partial = JSON.parse(raw) as Partial<BotConfig>;
    return { ...defaults, ...partial };
  } catch {
    return defaults;
  }
}

export function saveConfig(path: string, config: BotConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * One-time migration for the config location fix (#86).
 *
 * Older versions wrote config.json to the app/repo ROOT, which is NOT inside the
 * persisted data directory (the Docker volume is mounted at data/). That meant the
 * file never landed in the volume on first run and a manually-placed data/config.json
 * was ignored. config.json now lives under the data dir alongside the DB/cookies/logs.
 *
 * If a legacy root-level config exists and the new data-dir config does not yet exist,
 * move it so existing local installs keep their customized settings. Best-effort:
 * any failure is swallowed and loadConfig falls back to defaults.
 *
 * @returns true if a legacy config was migrated, false otherwise.
 */
export function migrateLegacyConfig(legacyPath: string, newPath: string): boolean {
  try {
    if (legacyPath === newPath) return false;
    if (existsSync(newPath)) return false; // new location already populated — leave it
    if (!existsSync(legacyPath)) return false; // nothing to migrate
    mkdirSync(dirname(newPath), { recursive: true });
    copyFileSync(legacyPath, newPath); // copy first (works across filesystems)
    try {
      rmSync(legacyPath);
    } catch {
      /* leave the legacy file if it can't be removed; the new one wins */
    }
    return true;
  } catch {
    return false;
  }
}
