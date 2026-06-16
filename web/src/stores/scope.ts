/** Given the desired scoped id (from ?bot) and the known bot ids, decide the
 * effective scope. Returns the id if it exists, else null (graceful clear:
 * a stale/forbidden id never locks the UI). */
export function resolveScopedBot(
  requestedId: string | null | undefined,
  knownBotIds: readonly string[],
): string | null {
  if (!requestedId) return null;
  return knownBotIds.includes(requestedId) ? requestedId : null;
}
