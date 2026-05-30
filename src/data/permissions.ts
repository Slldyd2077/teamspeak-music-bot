import type Database from "better-sqlite3";

export const CAPABILITIES = [
  "player.control",
  "player.queue",
  "bot.manage",
  "platform.auth",
  "quality",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Marker token stored in user_permissions meaning "all bots, incl. future". */
export const BOTS_ALL = "bots.all";

/** Capabilities granted to a newly-created member by default. */
export const BASIC_TIER_CAPABILITIES: Capability[] = ["player.control", "player.queue"];

export function isCapability(x: string): x is Capability {
  return (CAPABILITIES as readonly string[]).includes(x);
}

export type BotAccess = "all" | string[];

export interface PermissionStore {
  getCapabilities(userId: string): Capability[];
  getBotAccess(userId: string): BotAccess;
  setPermissions(userId: string, input: { capabilities: string[]; bots: BotAccess }): void;
  pruneBot(botId: string): void;
}

export function createPermissionStore(db: Database.Database): PermissionStore {
  const selCaps = db.prepare("SELECT permission FROM user_permissions WHERE userId = ?");
  const delCaps = db.prepare("DELETE FROM user_permissions WHERE userId = ?");
  const insCap = db.prepare("INSERT OR IGNORE INTO user_permissions (userId, permission) VALUES (?, ?)");
  const selBots = db.prepare("SELECT botId FROM user_bot_access WHERE userId = ?");
  const delBots = db.prepare("DELETE FROM user_bot_access WHERE userId = ?");
  const insBot = db.prepare("INSERT OR IGNORE INTO user_bot_access (userId, botId) VALUES (?, ?)");
  const pruneBotStmt = db.prepare("DELETE FROM user_bot_access WHERE botId = ?");

  return {
    getCapabilities(userId) {
      return (selCaps.all(userId) as { permission: string }[])
        .map((r) => r.permission)
        .filter((p): p is Capability => isCapability(p));
    },
    getBotAccess(userId) {
      const all = (selCaps.all(userId) as { permission: string }[]).some((r) => r.permission === BOTS_ALL);
      if (all) return "all";
      return (selBots.all(userId) as { botId: string }[]).map((r) => r.botId);
    },
    setPermissions(userId, input) {
      const caps = input.capabilities.filter(isCapability);
      const tx = db.transaction(() => {
        delCaps.run(userId);
        delBots.run(userId);
        for (const c of caps) insCap.run(userId, c);
        if (input.bots === "all") {
          insCap.run(userId, BOTS_ALL);
        } else {
          for (const b of input.bots) insBot.run(userId, b);
        }
      });
      tx();
    },
    pruneBot(botId) {
      pruneBotStmt.run(botId);
    },
  };
}

export interface PermissionContext {
  capabilities: Set<string>;
  bots: "all" | Set<string>;
}

export function resolvePermissionContext(
  role: "admin" | "member",
  userId: string,
  store: PermissionStore
): PermissionContext {
  if (role === "admin") {
    return { capabilities: new Set(CAPABILITIES), bots: "all" };
  }
  const access = store.getBotAccess(userId);
  return {
    capabilities: new Set(store.getCapabilities(userId)),
    bots: access === "all" ? "all" : new Set(access),
  };
}
