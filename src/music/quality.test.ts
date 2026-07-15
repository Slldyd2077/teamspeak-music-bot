import { describe, expect, it } from "vitest";
import { canUseQuality, qualityRequiresVip, validateQuality } from "./quality.js";

describe("audio quality policy", () => {
  it("requires VIP for premium lossless and hi-res levels", () => {
    expect(qualityRequiresVip("netease", "lossless")).toBe(true);
    expect(qualityRequiresVip("netease", "hires")).toBe(true);
    expect(qualityRequiresVip("qq", "flac")).toBe(true);
    expect(qualityRequiresVip("kugou", "high")).toBe(true);
  });

  it("allows ordinary qualities without a paid membership", () => {
    expect(canUseQuality("netease", "exhigh", { loggedIn: false, vip: false })).toBe(true);
    expect(canUseQuality("qq", "320", { loggedIn: true, vip: false })).toBe(true);
  });

  it("fails closed unless VIP is explicitly verified", () => {
    expect(canUseQuality("netease", "lossless", { loggedIn: true })).toBe(false);
    expect(canUseQuality("netease", "lossless", { loggedIn: true, vip: false })).toBe(false);
    expect(canUseQuality("netease", "lossless", { loggedIn: true, vip: true })).toBe(true);
  });

  it("rejects unsupported values instead of silently falling back", () => {
    expect(validateQuality("qq", "jymaster")).toBeNull();
    expect(validateQuality("qq", "flac")).toBe("flac");
  });
});
