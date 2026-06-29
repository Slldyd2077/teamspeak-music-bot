import fs from "node:fs";
import path from "node:path";

export type Platform = "netease" | "qq" | "bilibili";

/**
 * Per-bot cookie 存储：每个 bot 实例绑定各自的平台 cookie（隔离多用户平台账号）。
 * 文件路径：{cookieDir}/{botId}/{platform}.json
 */
export interface CookieStore {
  save(botId: string, platform: Platform, cookie: string): void;
  load(botId: string, platform: Platform): string;
}

export function createCookieStore(cookieDir: string): CookieStore {
  if (!fs.existsSync(cookieDir)) {
    fs.mkdirSync(cookieDir, { recursive: true });
  }

  const filePath = (botId: string, platform: Platform) =>
    path.join(cookieDir, botId, `${platform}.json`);

  return {
    save(botId, platform, cookie): void {
      // botId 为 UUID，作为目录名安全；仍做基础校验防路径遍历
      if (!botId || /[\\/]/.test(botId)) return;
      const dir = path.join(cookieDir, botId);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        filePath(botId, platform),
        JSON.stringify({ cookie, updatedAt: new Date().toISOString() }),
        { encoding: "utf-8", mode: 0o600 }
      );
    },

    load(botId, platform): string {
      if (!botId || /[\\/]/.test(botId)) return "";
      const fp = filePath(botId, platform);
      if (!fs.existsSync(fp)) return "";
      try {
        const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
        return data.cookie ?? "";
      } catch {
        return "";
      }
    },
  };
}
