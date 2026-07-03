import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import type { BotAccess, GuestPermissions } from "./permissions.js";
import { GUEST_PERMISSION_FLAGS } from "./permissions.js";

export interface GuestModeConfig {
  enabled: boolean;
  bots: BotAccess; // "all" | string[]
  permissions: GuestPermissions;
}

export interface SpotifyConfig {
  enabled: boolean;
  backend: "auto" | "go-librespot" | "librespot";
  clientId: string;
  clientSecret: string;
  deviceName: string;
  bitrate: number;
}

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
  /** Enable uploading and playback of server-stored local audio files. */
  localAudioEnabled: boolean;
  // Public base URL used when generating share links (e.g. the bot专属链接).
  // Leave empty to use the browser's current origin. Example:
  //   "https://music.example.com" or "http://1.2.3.4:3000"
  publicUrl: string;
  // When true, Express trusts X-Forwarded-* headers from a reverse proxy
  // (nginx/Caddy/Cloudflare). Required for correct protocol/host detection
  // behind HTTPS-terminating proxies.
  trustProxy: boolean;
  guestMode: GuestModeConfig;
  spotify: SpotifyConfig;
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
    localAudioEnabled: true,
    publicUrl: "",
    trustProxy: false,
    guestMode: {
      enabled: false,
      bots: "all",
      permissions: {
        addToQueue: true,
        playNext: false,
        playNow: false,
        skip: false,
        transport: false,
        removeClear: false,
        playMode: false,
        playCollection: false,
      },
    },
    spotify: {
      enabled: false,
      backend: "auto",
      clientId: "",
      clientSecret: "",
      deviceName: "TSMusicBot",
      bitrate: 320,
    },
  };
}

export function loadConfig(path: string): BotConfig {
  const defaults = getDefaultConfig();

  // Distinguish the three failure modes so a *real* on-disk config is NEVER
  // silently replaced with defaults (the caller saveConfig()s right after load,
  // which would otherwise erase spotify creds / adminPassword / adminGroups /
  // guestMode permanently):
  //   (a) file ABSENT (ENOENT) — normal first run → defaults.
  //   (b) any OTHER read error (EBUSY/EACCES/EPERM/EISDIR/…) on an existing file —
  //       rethrow (fail-fast at boot). A loud crash beats silent credential loss.
  //   (c) file readable but JSON.parse fails (corrupt) — back the file up first
  //       (never delete it), THEN return defaults so boot can proceed.
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaults; // (a) missing file — first run
    }
    throw err; // (b) transient/permission error on an existing file — do not clobber it
  }

  let partial: Partial<BotConfig>;
  try {
    partial = JSON.parse(raw) as Partial<BotConfig>;
  } catch {
    // (c) Corrupt content: move the unreadable file aside to a timestamped backup
    // so the data stays recoverable, then fall back to defaults. Prefer an atomic
    // same-dir rename; if that fails, copy instead. If it can't be preserved at
    // all, rethrow rather than let the caller overwrite unrecoverable data.
    const backup = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, backup);
    } catch {
      try {
        copyFileSync(path, backup);
      } catch (backupErr) {
        throw backupErr;
      }
    }
    return defaults;
  }

  {
    // Normalize/sanitize guestMode on load. The WRITE path (POST /api/bot/settings)
    // sanitizes too, but a hand-edited/legacy/corrupt config.json reaches the gate
    // directly — so coerce it here as well, mirroring that write-path logic.
    const partialGm = (partial.guestMode ?? {}) as Partial<GuestModeConfig>;
    const gm: GuestModeConfig = {
      ...defaults.guestMode,
      ...partialGm,
      // bots → "all" | string[]; anything else falls back to the default ("all").
      bots:
        partialGm.bots === "all"
          ? "all"
          : Array.isArray(partialGm.bots)
            ? partialGm.bots.filter((id): id is string => typeof id === "string")
            : defaults.guestMode.bots,
      // permissions → defaults, then spread ONLY a plain object, then strict-coerce
      // each known flag to a boolean (drops index keys + non-boolean values).
      permissions: { ...defaults.guestMode.permissions },
    };
    const partialPerms = partialGm.permissions;
    if (
      partialPerms !== null &&
      typeof partialPerms === "object" &&
      !Array.isArray(partialPerms)
    ) {
      Object.assign(gm.permissions, partialPerms);
    }
    for (const f of GUEST_PERMISSION_FLAGS) {
      gm.permissions[f] = gm.permissions[f] === true;
    }

    // Sanitize adminGroups on load too: the WebUI write path filters it, but a
    // hand-edited / legacy / corrupt config.json reaches the command gate
    // directly. Keep only non-negative integers; a non-array falls back to the
    // default []. Mirrors the guestMode sanitization above.
    const adminGroups = Array.isArray(partial.adminGroups)
      ? partial.adminGroups.filter(
          (g): g is number => typeof g === "number" && Number.isInteger(g) && g >= 0,
        )
      : defaults.adminGroups;

    const partialSp = (partial.spotify ?? {}) as Partial<SpotifyConfig>;
    const validBackends = ["auto", "go-librespot", "librespot"] as const;
    const validBitrates = [96, 160, 320];
    const spotify: SpotifyConfig = {
      enabled: partialSp.enabled === true,
      backend: (validBackends as readonly string[]).includes(partialSp.backend as string)
        ? (partialSp.backend as SpotifyConfig["backend"])
        : defaults.spotify.backend,
      clientId: typeof partialSp.clientId === "string" ? partialSp.clientId : defaults.spotify.clientId,
      clientSecret:
        typeof partialSp.clientSecret === "string" ? partialSp.clientSecret : defaults.spotify.clientSecret,
      deviceName:
        typeof partialSp.deviceName === "string" && partialSp.deviceName.trim()
          ? partialSp.deviceName
          : defaults.spotify.deviceName,
      bitrate: validBitrates.includes(partialSp.bitrate as number)
        ? (partialSp.bitrate as number)
        : defaults.spotify.bitrate,
    };

    return {
      ...defaults,
      ...partial,
      adminGroups,
      guestMode: gm,
      spotify,
    };
  }
}

export function saveConfig(path: string, config: BotConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(config, null, 2);

  // Atomic write: serialize to a sibling temp file in the SAME directory, then
  // rename it onto the final path. rename is an atomic replace on POSIX and modern
  // Windows, so a crash / power loss / ENOSPC mid-write can never leave config.json
  // truncated — a reader always sees either the previous file or the fully-written
  // new one, never a partial. The temp lives in the same dir so the rename stays on
  // one filesystem (a cross-device rename would fail); pid + timestamp keep
  // concurrent writers from colliding on the temp name.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, json, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    // Never leave a partial temp file behind on failure.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
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
