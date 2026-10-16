// Pure pagination helpers for Search.vue "加载更多" (load-more) per source + tab.
// Kept framework-free so root vitest can unit-cover the logic (see searchPagination.test.ts).

/** Minimal shape shared by songs / albums / playlists: needs a stable dedup key. */
export interface Keyed {
  id: string;
  platform: string;
}

/** Stable dedup key for a result item: `${platform}:${id}`. */
export function itemKey(item: Keyed): string {
  return `${item.platform}:${item.id}`;
}

/**
 * Merge `incoming` into `existing`, deduped by `${platform}:${id}`.
 * Order is preserved with existing items first; incoming items already present
 * (or duplicated within the incoming batch) are dropped.
 */
export function mergeDedup<T extends Keyed>(existing: T[], incoming: T[]): T[] {
  const seen = new Set<string>(existing.map(itemKey));
  const result = existing.slice();
  for (const item of incoming) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * Whether another page might exist: a full page (=== pageSize) means keep the
 * button; a short/empty page (< pageSize) means the source is exhausted.
 */
export function hasMore(returnedCount: number, pageSize: number): boolean {
  return returnedCount >= pageSize;
}

/**
 * Offset for the next page request. Offsets are page-aligned, so this is simply
 * the number of items already shown for that source+type.
 */
export function nextOffset(currentCountForSource: number, pageSize: number): number {
  return Math.ceil(currentCountForSource / pageSize) * pageSize;
}
