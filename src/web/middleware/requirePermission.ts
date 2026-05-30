import type { Request, Response, NextFunction, RequestHandler } from "express";

// Generic over the route-param shape (`P`) so Express can keep inferring
// `req.params` from the route string (e.g. `/:id` → `{ id: string }`) when
// these are passed as a per-route middleware argument. Pinning the default
// `ParamsDictionary` here would otherwise force the broad
// `string | string[]` param overload on every route they guard.
export function requirePermission<P = Record<string, string>>(capability: string): RequestHandler<P> {
  return (req: Request<P>, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (req.user.role === "admin" || req.user.capabilities?.has(capability)) { next(); return; }
    res.status(403).json({ error: "forbidden" });
  };
}

export function requireBotAccess<P = Record<string, string>>(paramName = "botId"): RequestHandler<P> {
  return (req: Request<P>, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (req.user.role === "admin" || req.user.bots === "all") { next(); return; }
    const botId = (req.params as Record<string, string | undefined>)[paramName];
    if (typeof botId === "string" && req.user.bots instanceof Set && req.user.bots.has(botId)) { next(); return; }
    res.status(403).json({ error: "forbidden" });
  };
}
