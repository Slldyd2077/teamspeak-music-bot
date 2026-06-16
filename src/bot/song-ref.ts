/**
 * Parsing helpers for picking an EXACT song in a !play / !add / !playnext query,
 * so same-name songs can be disambiguated instead of always getting the single
 * most-popular search hit (issue #90).
 *
 * Two mechanisms:
 *  - A song reference: an explicit id / platform URL → play that exact song.
 *  - A selection index: "#N" → the Nth result of the previous !search.
 */

export interface SongRef {
  id: string;
  /**
   * Platform inferred from a URL. `null` means the platform wasn't encoded in
   * the reference (e.g. a bare `id:`), so the caller should fall back to the
   * command's flags / default provider.
   */
  platform: "netease" | "qq" | "bilibili" | null;
}

/**
 * Detect an explicit song reference in a query. Recognizes:
 *   - `id:<id>`                         → platform from flags/default
 *   - NetEase song URL                  → music.163.com/song?id=N (also /#/song?id=N, /song/N)
 *   - QQ song URL                       → y.qq.com/.../songDetail/MID (or ?songmid=MID)
 *   - BiliBili BVID (bare or in a URL)  → bilibili.com/video/BVxxxx, b23.tv, or BVxxxx
 * Returns `null` for a plain search term (the common case).
 */
export function parseSongRef(raw: string): SongRef | null {
  const q = (raw ?? "").trim();
  if (!q) return null;

  // Explicit "id:<id>" — platform decided by the command's flags/default.
  const idPrefix = /^id:\s*(\S+)$/i.exec(q);
  if (idPrefix) return { id: idPrefix[1], platform: null };

  // BiliBili BV id, bare or inside a bilibili URL (NetEase ids are numeric, so
  // a "BV..." token never collides with them).
  const bv = /BV[0-9A-Za-z]{8,12}/.exec(q);
  if (bv && (/^BV[0-9A-Za-z]{8,12}$/.test(q) || /bilibili\.com|b23\.tv/i.test(q))) {
    return { id: bv[0], platform: "bilibili" };
  }

  // NetEase song URL.
  if (/music\.163\.com/i.test(q)) {
    const m = /[?&#/]id=(\d+)/.exec(q) ?? /\/song\/(\d+)/.exec(q);
    if (m) return { id: m[1], platform: "netease" };
  }

  // QQ song URL.
  if (/y\.qq\.com/i.test(q)) {
    const m = /songDetail\/([0-9A-Za-z]+)/.exec(q) ?? /[?&]songmid=([0-9A-Za-z]+)/i.exec(q);
    if (m) return { id: m[1], platform: "qq" };
  }

  return null;
}

/**
 * Detect a "#N" selection token (1-based) referencing the previous !search.
 * Returns the positive integer, or `null` when the query isn't a selection.
 */
export function parseSelectionIndex(raw: string): number | null {
  const m = /^#\s*(\d+)$/.exec((raw ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
