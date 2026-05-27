import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserStore {
  countUsers(): number;
  createUser(username: string, password: string): Promise<UserRow>;
  createFirstUser(username: string, password: string): Promise<UserRow | null>;
  findByUsername(username: string): UserRow | null;
  findById(id: string): UserRow | null;
  verifyPassword(plain: string, hash: string): Promise<boolean>;
  changePassword(userId: string, newPassword: string): Promise<void>;
  listUsers(): Array<{ id: string; username: string; createdAt: number }>;
  deleteUser(id: string): boolean;
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`username taken: ${username}`);
    this.name = "UsernameTakenError";
  }
}

export function createUserStore(db: Database.Database): UserStore {
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM users");
  const insertStmt = db.prepare(
    "INSERT INTO users (id, username, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
  );
  const findByUsernameStmt = db.prepare(
    "SELECT id, username, passwordHash, createdAt, updatedAt FROM users WHERE username = ? COLLATE NOCASE"
  );
  const findByIdStmt = db.prepare(
    "SELECT id, username, passwordHash, createdAt, updatedAt FROM users WHERE id = ?"
  );
  const updatePasswordStmt = db.prepare(
    "UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ?"
  );
  const listUsersStmt = db.prepare(
    "SELECT id, username, createdAt FROM users ORDER BY createdAt ASC"
  );
  const deleteUserStmt = db.prepare("DELETE FROM users WHERE id = ?");

  return {
    countUsers() {
      return (countStmt.get() as { n: number }).n;
    },

    async createUser(username, password) {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const id = randomUUID();
      const now = Date.now();
      try {
        insertStmt.run(id, username, hash, now, now);
      } catch (err) {
        if (err && typeof err === "object" && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new UsernameTakenError(username);
        }
        throw err;
      }
      return { id, username, passwordHash: hash, createdAt: now, updatedAt: now };
    },

    async createFirstUser(username, password) {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const id = randomUUID();
      const now = Date.now();
      const run = db.transaction(() => {
        const count = (countStmt.get() as { n: number }).n;
        if (count !== 0) return null;
        try {
          insertStmt.run(id, username, hash, now, now);
        } catch (err) {
          if (err && typeof err === "object" && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
            return null;
          }
          throw err;
        }
        return { id, username, passwordHash: hash, createdAt: now, updatedAt: now } as UserRow;
      });
      return run();
    },

    findByUsername(username) {
      return (findByUsernameStmt.get(username) as UserRow | undefined) ?? null;
    },

    findById(id) {
      return (findByIdStmt.get(id) as UserRow | undefined) ?? null;
    },

    verifyPassword(plain, hash) {
      return bcrypt.compare(plain, hash);
    },

    async changePassword(userId, newPassword) {
      const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      updatePasswordStmt.run(hash, Date.now(), userId);
    },

    listUsers() {
      return listUsersStmt.all() as Array<{ id: string; username: string; createdAt: number }>;
    },

    deleteUser(id) {
      const result = deleteUserStmt.run(id);
      return result.changes > 0;
    },
  };
}
