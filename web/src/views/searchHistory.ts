/**
 * Search history for the search page.
 *
 * Deliberately client-side (localStorage, per browser): the bot is shared by
 * many users, so a server-side history would leak one user's queries into
 * another's suggestions. Everything here is a pure function except the three
 * storage helpers, which accept an injected Storage-like so the list logic is
 * unit-testable without a DOM.
 */

export const SEARCH_HISTORY_MAX = 10;
export const SEARCH_HISTORY_STORAGE_KEY = 'search-history';

export interface SearchHistoryEntry {
  q: string;
  platform: string;
  at: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Accessing localStorage throws in some privacy modes.
    return null;
  }
}

function isEntry(value: unknown): value is SearchHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<SearchHistoryEntry>;
  return (
    typeof e.q === 'string' &&
    e.q.trim().length > 0 &&
    typeof e.platform === 'string' &&
    e.platform.length > 0 &&
    typeof e.at === 'number'
  );
}

export function parseHistory(raw: string | null | undefined): SearchHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).slice(0, SEARCH_HISTORY_MAX);
  } catch {
    return [];
  }
}

export function serializeHistory(list: SearchHistoryEntry[]): string {
  return JSON.stringify(list.slice(0, SEARCH_HISTORY_MAX));
}

export function sameEntry(
  entry: SearchHistoryEntry,
  q: string,
  platform: string,
): boolean {
  return (
    entry.platform === platform &&
    entry.q.toLowerCase() === q.trim().toLowerCase()
  );
}

/**
 * Newest first. Repeating a query for the same source moves the existing entry
 * to the front instead of adding a duplicate (case-insensitive on the query).
 */
export function pushHistory(
  list: SearchHistoryEntry[],
  q: string,
  platform: string,
  at = Date.now(),
): SearchHistoryEntry[] {
  const query = q.trim();
  if (!query || !platform) return list;
  const rest = list.filter((e) => !sameEntry(e, query, platform));
  return [{ q: query, platform, at }, ...rest].slice(0, SEARCH_HISTORY_MAX);
}

export function removeHistory(
  list: SearchHistoryEntry[],
  q: string,
  platform: string,
): SearchHistoryEntry[] {
  return list.filter((e) => !sameEntry(e, q, platform));
}

/** Entries for the currently selected source, newest first. */
export function historyForPlatform(
  list: SearchHistoryEntry[],
  platform: string,
): SearchHistoryEntry[] {
  return list.filter((e) => e.platform === platform);
}

export function loadHistory(storage: StorageLike | null = defaultStorage()): SearchHistoryEntry[] {
  try {
    return parseHistory(storage?.getItem(SEARCH_HISTORY_STORAGE_KEY) ?? null);
  } catch {
    return [];
  }
}

export function saveHistory(
  list: SearchHistoryEntry[],
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(SEARCH_HISTORY_STORAGE_KEY, serializeHistory(list));
  } catch {
    // Storage full or unavailable — history is a convenience, not state.
  }
}

export function clearStoredHistory(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(SEARCH_HISTORY_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}
