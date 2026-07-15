import type { AuthStatus } from "./provider.js";

export type QualityPlatform = "netease" | "qq" | "bilibili" | "kugou";

export const QUALITY_POLICY: Record<QualityPlatform, Readonly<Record<string, boolean>>> = {
  netease: {
    standard: false,
    higher: false,
    exhigh: false,
    lossless: true,
    hires: true,
    jymaster: true,
  },
  qq: { "128": false, "320": false, flac: true },
  bilibili: { high: false },
  kugou: { "128": false, "320": false, flac: true, high: true },
};

export function isQualityPlatform(value: unknown): value is QualityPlatform {
  return typeof value === "string" && value in QUALITY_POLICY;
}

export function validateQuality(platform: QualityPlatform, quality: unknown): string | null {
  if (typeof quality !== "string" || !(quality in QUALITY_POLICY[platform])) return null;
  return quality;
}

export function qualityRequiresVip(platform: QualityPlatform, quality: string): boolean {
  return QUALITY_POLICY[platform][quality] === true;
}

export function canUseQuality(
  platform: QualityPlatform,
  quality: string,
  status: AuthStatus,
): boolean {
  return !qualityRequiresVip(platform, quality) || (status.loggedIn && status.vip === true);
}
