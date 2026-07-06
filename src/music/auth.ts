import fs from "node:fs";
import path from "node:path";

/** Cookie-bearing platforms that support per-bot login isolation. */
export type CookiePlatform = "netease" | "qq" | "bilibili" | "kugou";

/**
 * Per-bot platform cookie store. Cookies are keyed by (botId, platform) so each
 * bot owns its own platform login — `data/cookies/{botId}/{platform}.json`.
 *
 * No global fallback: a bot with no saved cookie loads as logged-out. (The legacy
 * `data/cookies/{platform}.json` files from the pre-isolation singleton era are
 * simply ignored.)
 */
export interface CookieStore {
  save(botId: string, platform: CookiePlatform, cookie: string): void;
  load(botId: string, platform: CookiePlatform): string;
}

export function createCookieStore(cookieDir: string): CookieStore {
  if (!fs.existsSync(cookieDir)) {
    fs.mkdirSync(cookieDir, { recursive: true });
  }

  return {
    save(botId, platform, cookie) {
      const botDir = path.join(cookieDir, botId);
      if (!fs.existsSync(botDir)) {
        fs.mkdirSync(botDir, { recursive: true });
      }
      const filePath = path.join(botDir, `${platform}.json`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({ cookie, updatedAt: new Date().toISOString() }),
        { encoding: "utf-8", mode: 0o600 },
      );
    },

    load(botId, platform) {
      const filePath = path.join(cookieDir, botId, `${platform}.json`);
      if (!fs.existsSync(filePath)) return "";
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return data.cookie ?? "";
      } catch {
        return "";
      }
    },
  };
}
