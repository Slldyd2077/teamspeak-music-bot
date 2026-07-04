import { describe, it, expect } from "vitest";
import { itemKey, mergeDedup, hasMore, nextOffset, type Keyed } from "./searchPagination.js";

const item = (platform: string, id: string): Keyed & { label: string } => ({
  platform,
  id,
  label: `${platform}:${id}`,
});

describe("searchPagination helpers (#115)", () => {
  describe("itemKey", () => {
    it("builds a `${platform}:${id}` key", () => {
      expect(itemKey({ platform: "netease", id: "42" })).toBe("netease:42");
    });

    it("distinguishes same id across platforms", () => {
      expect(itemKey({ platform: "qq", id: "1" })).not.toBe(itemKey({ platform: "netease", id: "1" }));
    });
  });

  describe("mergeDedup", () => {
    it("appends incoming items, existing first, order preserved", () => {
      const existing = [item("netease", "1"), item("netease", "2")];
      const incoming = [item("netease", "3"), item("netease", "4")];
      expect(mergeDedup(existing, incoming).map((x) => x.id)).toEqual(["1", "2", "3", "4"]);
    });

    it("drops incoming items already present in existing", () => {
      const existing = [item("netease", "1"), item("netease", "2")];
      const incoming = [item("netease", "2"), item("netease", "3")];
      expect(mergeDedup(existing, incoming).map((x) => x.id)).toEqual(["1", "2", "3"]);
    });

    it("drops duplicates within the incoming batch", () => {
      const existing = [item("netease", "1")];
      const incoming = [item("netease", "2"), item("netease", "2"), item("netease", "3")];
      expect(mergeDedup(existing, incoming).map((x) => x.id)).toEqual(["1", "2", "3"]);
    });

    it("treats same id on different platforms as distinct", () => {
      const existing = [item("netease", "1")];
      const incoming = [item("qq", "1")];
      const merged = mergeDedup(existing, incoming);
      expect(merged.map(itemKey)).toEqual(["netease:1", "qq:1"]);
    });

    it("does not mutate the existing array", () => {
      const existing = [item("netease", "1")];
      const before = existing.slice();
      mergeDedup(existing, [item("netease", "2")]);
      expect(existing).toEqual(before);
    });

    it("handles empty incoming", () => {
      const existing = [item("netease", "1")];
      expect(mergeDedup(existing, []).map((x) => x.id)).toEqual(["1"]);
    });
  });

  describe("hasMore", () => {
    it("is true when a full page came back", () => {
      expect(hasMore(20, 20)).toBe(true);
    });

    it("is false when a short page came back", () => {
      expect(hasMore(7, 20)).toBe(false);
    });

    it("is false when nothing came back", () => {
      expect(hasMore(0, 20)).toBe(false);
    });
  });

  describe("nextOffset", () => {
    it("returns the page-aligned offset for a full first page", () => {
      expect(nextOffset(20, 20)).toBe(20);
    });

    it("returns 0 when nothing is shown yet", () => {
      expect(nextOffset(0, 20)).toBe(0);
    });

    it("rounds up to the next page boundary after dedup drops items", () => {
      // page1 (20) + page2 minus 5 dupes -> 35 shown, next page cursor is 40.
      expect(nextOffset(35, 20)).toBe(40);
    });

    it("stays aligned across multiple full pages", () => {
      expect(nextOffset(40, 20)).toBe(40);
      expect(nextOffset(60, 20)).toBe(60);
    });
  });
});
