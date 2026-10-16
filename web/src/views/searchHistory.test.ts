import { describe, it, expect, beforeEach } from "vitest";
import {
  SEARCH_HISTORY_MAX,
  SEARCH_HISTORY_STORAGE_KEY,
  clearStoredHistory,
  historyForPlatform,
  loadHistory,
  parseHistory,
  pushHistory,
  removeHistory,
  sameEntry,
  saveHistory,
  serializeHistory,
  type SearchHistoryEntry,
} from "./searchHistory.js";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

const entry = (q: string, platform = "netease", at = 1): SearchHistoryEntry => ({ q, platform, at });

describe("search history", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
  });

  describe("pushHistory", () => {
    it("prepends the newest query", () => {
      const list = pushHistory([entry("old")], "new", "netease", 2);
      expect(list.map((e) => e.q)).toEqual(["new", "old"]);
    });

    it("trims the query and ignores blank input", () => {
      expect(pushHistory([], "  hello  ", "netease", 2)[0].q).toBe("hello");
      expect(pushHistory([entry("keep")], "   ", "netease", 2)).toEqual([entry("keep")]);
      expect(pushHistory([], "", "netease", 2)).toEqual([]);
    });

    it("moves a repeated query to the front instead of duplicating it", () => {
      const list = pushHistory([entry("b", "netease", 2), entry("a", "netease", 1)], "a", "netease", 3);
      expect(list.map((e) => e.q)).toEqual(["a", "b"]);
      expect(list[0].at).toBe(3);
    });

    it("matches repeated queries case-insensitively", () => {
      const list = pushHistory([entry("Hello", "netease", 1)], "hello", "netease", 2);
      expect(list).toHaveLength(1);
      expect(list[0].q).toBe("hello");
    });

    it("keeps the same query from a different source as its own entry", () => {
      const list = pushHistory([entry("hello", "netease", 1)], "hello", "qq", 2);
      expect(list).toHaveLength(2);
      expect(list.map((e) => e.platform)).toEqual(["qq", "netease"]);
    });

    it("caps the list at SEARCH_HISTORY_MAX, dropping the oldest", () => {
      let list: SearchHistoryEntry[] = [];
      for (let i = 1; i <= SEARCH_HISTORY_MAX + 3; i++) {
        list = pushHistory(list, `q${i}`, "netease", i);
      }
      expect(list).toHaveLength(SEARCH_HISTORY_MAX);
      expect(list[0].q).toBe(`q${SEARCH_HISTORY_MAX + 3}`);
      expect(list.at(-1)?.q).toBe("q4");
    });

    it("does not mutate the input list", () => {
      const list = [entry("a")];
      pushHistory(list, "b", "netease", 2);
      expect(list.map((e) => e.q)).toEqual(["a"]);
    });
  });

  describe("removeHistory", () => {
    it("removes only the matching query+source pair", () => {
      const list = [entry("a", "netease"), entry("a", "qq"), entry("b", "netease")];
      expect(removeHistory(list, "a", "netease").map((e) => `${e.platform}:${e.q}`)).toEqual([
        "qq:a",
        "netease:b",
      ]);
    });

    it("is case-insensitive on the query", () => {
      expect(removeHistory([entry("Hello")], "hello", "netease")).toEqual([]);
    });
  });

  describe("historyForPlatform", () => {
    it("returns only the selected source, newest first", () => {
      const list = [entry("a", "qq", 3), entry("b", "netease", 2), entry("c", "netease", 1)];
      expect(historyForPlatform(list, "netease").map((e) => e.q)).toEqual(["b", "c"]);
      expect(historyForPlatform(list, "bilibili")).toEqual([]);
    });
  });

  describe("parse/serialize", () => {
    it("round-trips a list", () => {
      const list = [entry("a"), entry("b", "qq", 5)];
      expect(parseHistory(serializeHistory(list))).toEqual(list);
    });

    it("returns [] for malformed or non-array payloads", () => {
      expect(parseHistory(null)).toEqual([]);
      expect(parseHistory("")).toEqual([]);
      expect(parseHistory("{not json")).toEqual([]);
      expect(parseHistory('{"q":"a"}')).toEqual([]);
    });

    it("drops entries that are missing required fields", () => {
      const raw = JSON.stringify([
        { q: "ok", platform: "netease", at: 1 },
        { q: "", platform: "netease", at: 2 },
        { q: "no-platform", platform: "", at: 3 },
        { q: "no-time", platform: "qq" },
        { q: "not-an-object", platform: 5, at: 4 },
      ]);
      expect(parseHistory(raw).map((e) => e.q)).toEqual(["ok"]);
    });

    it("truncates over-long stored payloads to the cap", () => {
      const raw = JSON.stringify(
        Array.from({ length: SEARCH_HISTORY_MAX + 5 }, (_, i) => entry(`q${i}`, "netease", i)),
      );
      expect(parseHistory(raw)).toHaveLength(SEARCH_HISTORY_MAX);
    });
  });

  describe("storage helpers", () => {
    it("round-trips through the injected storage", () => {
      saveHistory([entry("persisted", "qq", 9)], storage);
      expect(loadHistory(storage)).toEqual([entry("persisted", "qq", 9)]);
      expect(Object.keys(storage.dump())).toEqual([SEARCH_HISTORY_STORAGE_KEY]);
    });

    it("loads [] when the key is absent", () => {
      expect(loadHistory(storage)).toEqual([]);
    });

    it("loads [] instead of throwing on corrupt storage", () => {
      const bad = memoryStorage({ [SEARCH_HISTORY_STORAGE_KEY]: "}{" });
      expect(loadHistory(bad)).toEqual([]);
    });

    it("clearStoredHistory removes the key", () => {
      saveHistory([entry("a")], storage);
      clearStoredHistory(storage);
      expect(storage.dump()).toEqual({});
      expect(loadHistory(storage)).toEqual([]);
    });

    it("survives a storage that throws on every access", () => {
      const hostile = {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
        removeItem: () => {
          throw new Error("denied");
        },
      };
      expect(loadHistory(hostile)).toEqual([]);
      expect(() => saveHistory([entry("a")], hostile)).not.toThrow();
      expect(() => clearStoredHistory(hostile)).not.toThrow();
    });

    it("tolerates a null storage (SSR / privacy mode)", () => {
      expect(loadHistory(null)).toEqual([]);
      expect(() => saveHistory([entry("a")], null)).not.toThrow();
    });
  });

  describe("sameEntry", () => {
    it("compares platform and case-insensitive query", () => {
      expect(sameEntry(entry("Hello", "qq"), " hello ", "qq")).toBe(true);
      expect(sameEntry(entry("Hello", "qq"), "hello", "netease")).toBe(false);
    });
  });
});
