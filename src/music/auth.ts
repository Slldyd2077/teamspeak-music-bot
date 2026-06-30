import fs from "node:fs";
import path from "node:path";

export interface CookieStore {
  save(platform: "netease" | "qq" | "bilibili" | "kugou", cookie: string): void;
  load(platform: "netease" | "qq" | "bilibili" | "kugou"): string;
}

export function createCookieStore(cookieDir: string): CookieStore {
  if (!fs.existsSync(cookieDir)) {
    fs.mkdirSync(cookieDir, { recursive: true });
  }

  return {
    save(platform: "netease" | "qq" | "bilibili" | "kugou", cookie: string): void {
      const filePath = path.join(cookieDir, `${platform}.json`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({ cookie, updatedAt: new Date().toISOString() }),
        { encoding: "utf-8", mode: 0o600 }
      );
    },

    load(platform: "netease" | "qq" | "bilibili" | "kugou"): string {
      const filePath = path.join(cookieDir, `${platform}.json`);
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
