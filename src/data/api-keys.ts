import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const MAX_API_KEYS_PER_USER = 20;
export const API_KEY_TOUCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
/** Visible prefix stored for list views, e.g. "tsmb_a1b2c3d4". */
export const API_KEY_PREFIX_LENGTH = 12;

export interface ApiKeyRow {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface ApiKeyWithUser extends ApiKeyRow {
  username: string;
}

export interface ApiKeyValidation {
  keyId: string;
  userId: string;
  username: string;
  role: "admin" | "member";
}

export interface CreatedApiKey {
  key: ApiKeyRow;
  /** Plaintext key — returned exactly once, at creation time. */
  rawKey: string;
}

export interface ApiKeyStore {
  /** Returns null when the per-user key cap is reached. */
  create(userId: string, name: string): CreatedApiKey | null;
  findById(id: string): ApiKeyWithUser | null;
  listForUser(userId: string): ApiKeyRow[];
  listAll(): ApiKeyWithUser[];
  /** With userId, only deletes a key owned by that user. */
  delete(id: string, userId?: string): boolean;
  deleteAllForUser(userId: string): void;
  validateAndTouch(rawKey: string): ApiKeyValidation | null;
}

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function createApiKeyStore(db: Database.Database): ApiKeyStore {
  const insertStmt = db.prepare(
    "INSERT INTO api_keys (id, userId, name, keyHash, keyPrefix, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)"
  );
  const selectForUserStmt = db.prepare(
    "SELECT id, userId, name, keyPrefix, createdAt, lastUsedAt FROM api_keys WHERE userId = ? ORDER BY createdAt DESC"
  );
  const selectAllStmt = db.prepare(
    `SELECT k.id, k.userId, k.name, k.keyPrefix, k.createdAt, k.lastUsedAt, u.username
     FROM api_keys k INNER JOIN users u ON u.id = k.userId
     ORDER BY k.createdAt DESC`
  );
  const selectByIdStmt = db.prepare(
    `SELECT k.id, k.userId, k.name, k.keyPrefix, k.createdAt, k.lastUsedAt, u.username
     FROM api_keys k INNER JOIN users u ON u.id = k.userId
     WHERE k.id = ?`
  );
  const deleteStmt = db.prepare("DELETE FROM api_keys WHERE id = ?");
  const deleteAllForUserStmt = db.prepare("DELETE FROM api_keys WHERE userId = ?");
  const countForUserStmt = db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE userId = ?");
  const validateStmt = db.prepare(
    `SELECT k.id, k.userId, k.lastUsedAt, u.username, u.role
     FROM api_keys k INNER JOIN users u ON u.id = k.userId
     WHERE k.keyHash = ?`
  );
  const touchStmt = db.prepare("UPDATE api_keys SET lastUsedAt = ? WHERE id = ?");

  return {
    create(userId, name) {
      const count = (countForUserStmt.get(userId) as { n: number }).n;
      if (count >= MAX_API_KEYS_PER_USER) {
        return null;
      }
      const rawKey = `tsmb_${randomBytes(32).toString("base64url")}`;
      const row: ApiKeyRow = {
        id: randomUUID(),
        userId,
        name,
        keyPrefix: rawKey.slice(0, API_KEY_PREFIX_LENGTH),
        createdAt: Date.now(),
        lastUsedAt: null,
      };
      insertStmt.run(row.id, row.userId, row.name, hashKey(rawKey), row.keyPrefix, row.createdAt);
      return { key: row, rawKey };
    },

    findById(id) {
      return (selectByIdStmt.get(id) as ApiKeyWithUser | undefined) ?? null;
    },

    listForUser(userId) {
      return selectForUserStmt.all(userId) as ApiKeyRow[];
    },

    listAll() {
      return selectAllStmt.all() as ApiKeyWithUser[];
    },

    delete(id, userId) {
      const row = selectByIdStmt.get(id) as ApiKeyRow | undefined;
      if (!row) return false;
      if (userId !== undefined && row.userId !== userId) return false;
      deleteStmt.run(id);
      return true;
    },

    deleteAllForUser(userId) {
      deleteAllForUserStmt.run(userId);
    },

    validateAndTouch(rawKey) {
      if (!rawKey) return null;
      const row = validateStmt.get(hashKey(rawKey)) as
        | { id: string; userId: string; lastUsedAt: number | null; username: string; role: string }
        | undefined;
      if (!row) return null;
      // The reserved guest principal must never authenticate via API keys;
      // guest access is session-only by design.
      if (row.role !== "admin" && row.role !== "member") return null;
      const now = Date.now();
      if (row.lastUsedAt === null || now - row.lastUsedAt > API_KEY_TOUCH_INTERVAL_MS) {
        touchStmt.run(now, row.id);
      }
      return { keyId: row.id, userId: row.userId, username: row.username, role: row.role };
    },
  };
}
