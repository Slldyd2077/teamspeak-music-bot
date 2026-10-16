import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { createDatabase, type BotDatabase } from "./database.js";
import { createUserStore, type UserStore } from "./users.js";
import {
  createApiKeyStore,
  type ApiKeyStore,
  MAX_API_KEYS_PER_USER,
  API_KEY_TOUCH_INTERVAL_MS,
} from "./api-keys.js";

function sha256(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

describe("ApiKeyStore", () => {
  let botDb: BotDatabase;
  let users: UserStore;
  let keys: ApiKeyStore;
  let userId: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    users = createUserStore(botDb.db);
    keys = createApiKeyStore(botDb.db);
    const u = await users.createUser("alice", "pw-alice", "admin");
    userId = u.id;
  });

  afterEach(() => {
    vi.useRealTimers();
    botDb.close();
  });

  it("create returns a tsmb_-prefixed raw key whose sha256 is stored, never the plaintext", () => {
    const created = keys.create(userId, "ci");
    expect(created).not.toBeNull();
    expect(created!.rawKey).toMatch(/^tsmb_[A-Za-z0-9_-]{40,}$/);
    const row = botDb.db.prepare("SELECT keyHash, keyPrefix FROM api_keys").get() as {
      keyHash: string;
      keyPrefix: string;
    };
    expect(row.keyHash).toBe(sha256(created!.rawKey));
    expect(row.keyHash).not.toContain(created!.rawKey);
    expect(created!.key.keyPrefix).toBe(created!.rawKey.slice(0, 12));
  });

  it("validateAndTouch resolves the owner user for a fresh key", () => {
    const { rawKey } = keys.create(userId, "ci")!;
    const result = keys.validateAndTouch(rawKey);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(userId);
    expect(result!.username).toBe("alice");
    expect(result!.role).toBe("admin");
  });

  it("validateAndTouch returns null for an unknown or empty key", () => {
    keys.create(userId, "ci");
    expect(keys.validateAndTouch("tsmb_not-a-real-key")).toBeNull();
    expect(keys.validateAndTouch("")).toBeNull();
  });

  it("delete removes the key so it no longer validates", () => {
    const { key, rawKey } = keys.create(userId, "ci")!;
    expect(keys.delete(key.id, userId)).toBe(true);
    expect(keys.validateAndTouch(rawKey)).toBeNull();
  });

  it("delete with userId refuses to remove another user's key", async () => {
    const { key } = keys.create(userId, "ci")!;
    const other = await users.createUser("bob", "pw-bob", "member");
    expect(keys.delete(key.id, other.id)).toBe(false);
    expect(keys.delete(key.id)).toBe(true);
  });

  it("keys of a deleted user stop validating", async () => {
    const { rawKey } = keys.create(userId, "ci")!;
    users.deleteUser(userId);
    expect(keys.validateAndTouch(rawKey)).toBeNull();
  });

  it("enforces the per-user key cap", () => {
    for (let i = 0; i < MAX_API_KEYS_PER_USER; i++) {
      expect(keys.create(userId, `key-${i}`)).not.toBeNull();
    }
    expect(keys.create(userId, "one-too-many")).toBeNull();
    expect(keys.listForUser(userId)).toHaveLength(MAX_API_KEYS_PER_USER);
  });

  it("touches lastUsedAt at most once per interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { rawKey } = keys.create(userId, "ci")!;
    keys.validateAndTouch(rawKey);
    const first = (botDb.db.prepare("SELECT lastUsedAt FROM api_keys").get() as { lastUsedAt: number }).lastUsedAt;
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + 30_000);
    keys.validateAndTouch(rawKey);
    const second = (botDb.db.prepare("SELECT lastUsedAt FROM api_keys").get() as { lastUsedAt: number }).lastUsedAt;
    expect(second).toBe(first);
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + API_KEY_TOUCH_INTERVAL_MS + 1000);
    keys.validateAndTouch(rawKey);
    const third = (botDb.db.prepare("SELECT lastUsedAt FROM api_keys").get() as { lastUsedAt: number }).lastUsedAt;
    expect(third).toBeGreaterThan(first);
  });

  it("deleteAllForUser clears every key of that user", async () => {
    keys.create(userId, "a");
    keys.create(userId, "b");
    const other = await users.createUser("bob", "pw-bob", "member");
    keys.create(other.id, "c");
    keys.deleteAllForUser(userId);
    expect(keys.listForUser(userId)).toHaveLength(0);
    expect(keys.listForUser(other.id)).toHaveLength(1);
  });

  it("listAll exposes usernames for admin views", async () => {
    keys.create(userId, "ci");
    const other = await users.createUser("bob", "pw-bob", "member");
    keys.create(other.id, "deploy");
    const all = keys.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((k) => k.username).sort()).toEqual(["alice", "bob"]);
  });
});
