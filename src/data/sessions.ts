import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface SessionValidation {
  userId: string;
  username: string;
}

export interface SessionStore {
  createSession(userId: string): { token: string; expiresAt: number };
  validateAndTouch(rawToken: string): SessionValidation | null;
  deleteSession(rawToken: string): void;
  deleteAllForUser(userId: string, exceptToken?: string): void;
  cleanupExpired(): void;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSessionStore(db: Database.Database): SessionStore {
  const insertStmt = db.prepare(
    "INSERT INTO sessions (id, userId, createdAt, expiresAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)"
  );
  const selectStmt = db.prepare(`
    SELECT s.id, s.userId, s.expiresAt, s.lastSeenAt, u.username
    FROM sessions s INNER JOIN users u ON u.id = s.userId
    WHERE s.id = ?
  `);
  const deleteByIdStmt = db.prepare("DELETE FROM sessions WHERE id = ?");
  const touchStmt = db.prepare(
    "UPDATE sessions SET lastSeenAt = ?, expiresAt = ? WHERE id = ?"
  );
  const deleteAllForUserStmt = db.prepare("DELETE FROM sessions WHERE userId = ?");
  const deleteAllForUserExceptStmt = db.prepare(
    "DELETE FROM sessions WHERE userId = ? AND id != ?"
  );
  const cleanupStmt = db.prepare("DELETE FROM sessions WHERE expiresAt < ?");

  return {
    createSession(userId) {
      const token = randomBytes(32).toString("base64url");
      const id = hashToken(token);
      const now = Date.now();
      const expiresAt = now + SESSION_TTL_MS;
      insertStmt.run(id, userId, now, expiresAt, now);
      return { token, expiresAt };
    },

    validateAndTouch(rawToken) {
      if (!rawToken) return null;
      const id = hashToken(rawToken);
      const row = selectStmt.get(id) as
        | { id: string; userId: string; expiresAt: number; lastSeenAt: number; username: string }
        | undefined;
      if (!row) return null;
      const now = Date.now();
      if (row.expiresAt < now) {
        deleteByIdStmt.run(id);
        return null;
      }
      if (now - row.lastSeenAt > SESSION_TOUCH_INTERVAL_MS) {
        touchStmt.run(now, now + SESSION_TTL_MS, id);
      }
      return { userId: row.userId, username: row.username };
    },

    deleteSession(rawToken) {
      deleteByIdStmt.run(hashToken(rawToken));
    },

    deleteAllForUser(userId, exceptToken) {
      if (exceptToken) {
        deleteAllForUserExceptStmt.run(userId, hashToken(exceptToken));
      } else {
        deleteAllForUserStmt.run(userId);
      }
    },

    cleanupExpired() {
      cleanupStmt.run(Date.now());
    },
  };
}
