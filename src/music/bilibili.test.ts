import { describe, it, expect, vi } from "vitest";
import { BiliBiliProvider } from "./bilibili.js";

describe("BiliBiliProvider.search pagination", () => {
  function mockProvider() {
    const p = new BiliBiliProvider();
    const get = vi.fn().mockResolvedValue({ data: { data: { result: [] } } });
    // Short-circuit the buvid + wbi bootstrap so search only issues the
    // /search/type request we want to inspect.
    (p as any).buvidInitialized = true;
    (p as any).wbiMixinKey = "0".repeat(32);
    (p as any).wbiKeyFetchedAt = Date.now();
    (p as any).api = { get };
    return { p, get };
  }

  function searchParams(get: ReturnType<typeof vi.fn>) {
    const call = get.mock.calls.find(
      (c: any[]) => c[0] === "/x/web-interface/wbi/search/type"
    );
    expect(call, "expected a /search/type call").toBeTruthy();
    // signWbi stringifies every value.
    return call![1].params as Record<string, string>;
  }

  it("adds page (offset/limit+1) alongside page_size", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 20, 20); // page 2
    const params = searchParams(get);
    expect(params.page).toBe("2");
    expect(params.page_size).toBe("20");
  });

  it("defaults offset to 0 → page 1 (backward compatible)", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 20);
    expect(searchParams(get).page).toBe("1");
  });
});
