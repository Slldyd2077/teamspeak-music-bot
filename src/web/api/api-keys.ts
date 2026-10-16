import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { ApiKeyStore } from "../../data/api-keys.js";
import { MAX_API_KEYS_PER_USER } from "../../data/api-keys.js";
import type { AuditStore } from "../../data/audit.js";
import type { Logger } from "../../logger.js";

/**
 * API-key management (list / create / revoke), mounted at /api/keys.
 * Only interactive sessions may call these endpoints. Administrator keys
 * retain user-management authority through /api/users.
 */
export function createApiKeysRouter(apiKeys: ApiKeyStore, audit: AuditStore, logger: Logger): Router {
  const router = Router();

  const rejectApiKeyAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (req.authMethod === "api-key") {
      res.status(403).json({ error: "API keys cannot manage API keys — log in to the WebUI" });
      return;
    }
    next();
  };
  router.use(rejectApiKeyAuth);

  // GET /api/keys — the caller's keys; admins may pass ?all=1 for every user's.
  router.get("/", (req, res) => {
    const user = req.user!;
    if (req.query.all === "1" && user.role === "admin") {
      res.json({ keys: apiKeys.listAll() });
      return;
    }
    res.json({ keys: apiKeys.listForUser(user.id) });
  });

  // POST /api/keys — create a key; the plaintext is returned exactly once.
  router.post("/", (req, res) => {
    const user = req.user!;
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 64) {
      res.status(400).json({ error: "name is required (1-64 characters)" });
      return;
    }
    const created = apiKeys.create(user.id, name);
    if (!created) {
      res.status(409).json({ error: `每个用户最多创建 ${MAX_API_KEYS_PER_USER} 个 API Key` });
      return;
    }
    try {
      audit.record({
        actorId: user.id,
        actorUsername: user.username,
        targetUserId: user.id,
        targetUsername: user.username,
        action: "api_key.created",
      });
    } catch (auditErr) {
      logger.warn({ err: auditErr, action: "api_key.created" }, "audit insert failed");
    }
    logger.info({ userId: user.id, keyId: created.key.id }, "API key created");
    res.status(201).json(created);
  });

  // DELETE /api/keys/:id — revoke; members only their own, admins any.
  router.delete("/:id", (req, res) => {
    const user = req.user!;
    const key = apiKeys.findById(req.params.id);
    if (!key || !apiKeys.delete(key.id, user.role === "admin" ? undefined : user.id)) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    try {
      audit.record({
        actorId: user.id,
        actorUsername: user.username,
        targetUserId: key.userId,
        targetUsername: key.username,
        action: "api_key.deleted",
      });
    } catch (auditErr) {
      logger.warn({ err: auditErr, action: "api_key.deleted" }, "audit insert failed");
    }
    logger.info({ userId: user.id, keyId: req.params.id }, "API key deleted");
    res.json({ success: true });
  });

  return router;
}
