import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabase, type BotDatabase } from "./database.js";
import { createPermissionStore } from "./permissions.js";
import { CAPABILITIES, BASIC_TIER_CAPABILITIES, resolvePermissionContext } from "./permissions.js";

describe("PermissionStore", () => {
  let dbFile: string;
  let db: BotDatabase;

  beforeEach(() => {
    dbFile = path.join(os.tmpdir(), `perm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = createDatabase(dbFile);
    db.db.prepare(
      "INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES (?,?,?,?,?,?)"
    ).run("u1", "alice", "x", Date.now(), Date.now(), "member");
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(dbFile, { force: true }); } catch {}
    try { fs.rmSync(dbFile + "-wal", { force: true }); } catch {}
    try { fs.rmSync(dbFile + "-shm", { force: true }); } catch {}
  });

  it("exposes the five capability tokens and a basic tier", () => {
    expect(CAPABILITIES).toEqual([
      "player.control", "player.queue", "bot.manage", "platform.auth", "quality",
    ]);
    expect(BASIC_TIER_CAPABILITIES).toEqual(["player.control", "player.queue"]);
  });

  it("defaults to no capabilities and no bots", () => {
    const store = createPermissionStore(db.db);
    expect(store.getCapabilities("u1")).toEqual([]);
    expect(store.getBotAccess("u1")).toEqual([]);
  });

  it("round-trips capabilities and a specific bot list", () => {
    const store = createPermissionStore(db.db);
    store.setPermissions("u1", { capabilities: ["player.control", "quality"], bots: ["botA", "botB"] });
    expect(store.getCapabilities("u1").sort()).toEqual(["player.control", "quality"]);
    expect(store.getBotAccess("u1")).toEqual(["botA", "botB"]);
  });

  it("stores the all-bots flag as 'all'", () => {
    const store = createPermissionStore(db.db);
    store.setPermissions("u1", { capabilities: ["player.control"], bots: "all" });
    expect(store.getBotAccess("u1")).toBe("all");
  });

  it("setPermissions replaces prior capabilities and bots", () => {
    const store = createPermissionStore(db.db);
    store.setPermissions("u1", { capabilities: ["player.control"], bots: ["botA"] });
    store.setPermissions("u1", { capabilities: ["quality"], bots: "all" });
    expect(store.getCapabilities("u1")).toEqual(["quality"]);
    expect(store.getBotAccess("u1")).toBe("all");
  });

  it("ignores unknown capability tokens", () => {
    const store = createPermissionStore(db.db);
    store.setPermissions("u1", { capabilities: ["player.control", "bogus" as any], bots: [] });
    expect(store.getCapabilities("u1")).toEqual(["player.control"]);
  });

  it("pruneBot removes a bot from every user's allow-list", () => {
    const store = createPermissionStore(db.db);
    store.setPermissions("u1", { capabilities: [], bots: ["botA", "botB"] });
    store.pruneBot("botA");
    expect(store.getBotAccess("u1")).toEqual(["botB"]);
  });

  describe("resolvePermissionContext", () => {
    it("admin gets all capabilities and all bots regardless of stored rows", () => {
      const store = createPermissionStore(db.db);
      const ctx = resolvePermissionContext("admin", "u1", store);
      expect([...ctx.capabilities].sort()).toEqual([...CAPABILITIES].sort());
      expect(ctx.bots).toBe("all");
    });
    it("member reflects stored capabilities + bot access", () => {
      const store = createPermissionStore(db.db);
      store.setPermissions("u1", { capabilities: ["player.control"], bots: ["b1"] });
      const ctx = resolvePermissionContext("member", "u1", store);
      expect([...ctx.capabilities]).toEqual(["player.control"]);
      expect(ctx.bots).toEqual(new Set(["b1"]));
    });
  });
});

import { GUEST_PERMISSION_FLAGS } from "./permissions.js";

describe("resolvePermissionContext guest branch", () => {
  const noStore = {
    getCapabilities: () => [],
    getBotAccess: () => [] as string[],
    setPermissions: () => {},
    pruneBot: () => {},
  };

  it("guest has no member capabilities and exposes the guest permissions + bots", () => {
    const ctx = resolvePermissionContext("guest", "__guest__", noStore, {
      bots: ["bot1"],
      permissions: {
        addToQueue: true, playNext: false, playNow: false,
        skip: true, transport: false, removeClear: false, playMode: false,
      },
    });
    expect([...ctx.capabilities]).toEqual([]);
    expect(ctx.bots).toBeInstanceOf(Set);
    expect((ctx.bots as Set<string>).has("bot1")).toBe(true);
    expect(ctx.guest?.addToQueue).toBe(true);
    expect(ctx.guest?.skip).toBe(true);
  });

  it("guest with bots:'all' resolves to 'all'", () => {
    const ctx = resolvePermissionContext("guest", "__guest__", noStore, {
      bots: "all",
      permissions: {
        addToQueue: true, playNext: false, playNow: false,
        skip: false, transport: false, removeClear: false, playMode: false,
      },
    });
    expect(ctx.bots).toBe("all");
  });

  it("exposes the 7 canonical flags", () => {
    expect([...GUEST_PERMISSION_FLAGS].sort()).toEqual(
      ["addToQueue", "playMode", "playNext", "playNow", "removeClear", "skip", "transport"].sort()
    );
  });
});
