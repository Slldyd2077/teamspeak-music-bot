import { Router } from "express";
import type { Logger } from "../../logger.js";
import type { UserStore } from "../../data/users.js";
import { UsernameTakenError } from "../../data/users.js";
import type { SessionStore } from "../../data/sessions.js";
import type { AuditStore } from "../../data/audit.js";

function isValidUsername(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_\-.]{3,32}$/.test(v);
}

function isValidPassword(v: unknown): v is string {
  return typeof v === "string" && v.length >= 8 && v.length <= 200;
}

export function createUsersRouter(
  users: UserStore,
  sessions: SessionStore,
  audit: AuditStore,
  logger: Logger
): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ users: users.listUsers() });
  });

  router.post("/", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (!isValidUsername(username) || !isValidPassword(password)) {
      res.status(400).json({ error: "invalid username or password" });
      return;
    }
    try {
      const u = await users.createUser(username, password);
      audit.record({
        actorId: req.user!.id, actorUsername: req.user!.username,
        targetUserId: u.id, targetUsername: u.username,
        action: "user.created",
      });
      logger.info({ createdBy: req.user!.id, newUserId: u.id, username }, "User created");
      res.status(201).json({ id: u.id, username: u.username });
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        res.status(409).json({ error: "username taken" });
        return;
      }
      logger.error({ err }, "createUser failed");
      res.status(500).json({ error: "internal" });
    }
  });

  router.delete("/:id", (req, res) => {
    const targetId = req.params.id;
    const target = users.findById(targetId);
    if (!target) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (targetId === req.user!.id) {
      res.status(400).json({ error: "cannot delete self" });
      return;
    }
    const deleted = users.deleteUser(targetId);
    if (!deleted) {
      res.status(404).json({ error: "not found" });
      return;
    }
    sessions.deleteAllForUser(targetId);
    audit.record({
      actorId: req.user!.id, actorUsername: req.user!.username,
      targetUserId: target.id, targetUsername: target.username,
      action: "user.deleted",
    });
    logger.info({ deletedBy: req.user!.id, deletedUserId: targetId }, "User deleted");
    res.status(204).end();
  });

  router.post("/:id/reset-password", async (req, res) => {
    const { newPassword } = req.body ?? {};
    if (!isValidPassword(newPassword)) {
      res.status(400).json({ error: "invalid password" });
      return;
    }
    const targetId = req.params.id;
    const target = users.findById(targetId);
    if (!target) {
      res.status(404).json({ error: "not found" });
      return;
    }
    await users.changePassword(targetId, newPassword);
    // Invalidate all sessions for the target user (except current actor's if it's the same user)
    const exceptToken = targetId === req.user!.id ? undefined : undefined;
    sessions.deleteAllForUser(targetId, exceptToken);
    audit.record({
      actorId: req.user!.id, actorUsername: req.user!.username,
      targetUserId: target.id, targetUsername: target.username,
      action: "user.password_reset",
    });
    logger.info({ resetBy: req.user!.id, targetUserId: targetId }, "Password reset");
    res.status(204).end();
  });

  return router;
}
