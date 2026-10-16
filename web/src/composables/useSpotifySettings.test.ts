import { describe, it, expect } from "vitest";
import {
  buildSpotifyPayload,
  parseSpotifyRedirect,
  statusSummary,
  SPOTIFY_DISCLAIMER,
  type SpotifyConfigForm,
  type SpotifyStatus,
} from "./useSpotifySettings.js";

function form(overrides: Partial<SpotifyConfigForm> = {}): SpotifyConfigForm {
  return {
    enabled: true,
    backend: "auto",
    clientId: "abc",
    clientSecret: "",
    deviceName: "TS-Bot",
    bitrate: 320,
    ...overrides,
  };
}

describe("buildSpotifyPayload", () => {
  it("always includes enabled/backend/clientId/deviceName/bitrate under a spotify key", () => {
    const { spotify } = buildSpotifyPayload(form());
    expect(spotify).toMatchObject({
      enabled: true,
      backend: "auto",
      clientId: "abc",
      deviceName: "TS-Bot",
      bitrate: 320,
    });
  });

  it("omits clientSecret when blank (means unchanged, never wipes)", () => {
    const { spotify } = buildSpotifyPayload(form({ clientSecret: "" }));
    expect("clientSecret" in spotify).toBe(false);
  });

  it("includes clientSecret only when non-blank", () => {
    const { spotify } = buildSpotifyPayload(form({ clientSecret: "s3cr3t" }));
    expect(spotify.clientSecret).toBe("s3cr3t");
  });

  it("carries a non-default backend through unchanged", () => {
    const { spotify } = buildSpotifyPayload(form({ backend: "librespot" }));
    expect(spotify.backend).toBe("librespot");
  });
});

describe("parseSpotifyRedirect", () => {
  it("maps ?spotify=success to 'success'", () => {
    expect(parseSpotifyRedirect("?spotify=success")).toBe("success");
  });

  it("maps ?spotify=error to 'error'", () => {
    expect(parseSpotifyRedirect("?spotify=error")).toBe("error");
  });

  it("returns null for unrelated params", () => {
    expect(parseSpotifyRedirect("?x=1")).toBeNull();
  });

  it("returns null for an empty search string", () => {
    expect(parseSpotifyRedirect("")).toBeNull();
  });

  it("returns null for an unexpected spotify value", () => {
    expect(parseSpotifyRedirect("?spotify=maybe")).toBeNull();
  });
});

describe("statusSummary", () => {
  const ok: SpotifyStatus = { authorized: true, backend: "go-librespot", deviceName: "d", binaryAvailable: true };

  it("is 'off' tone when disabled, regardless of status", () => {
    expect(statusSummary(null, false).tone).toBe("off");
    expect(statusSummary(ok, false).tone).toBe("off");
  });

  it("is 'warn' tone when enabled but status is unknown (null)", () => {
    expect(statusSummary(null, true).tone).toBe("warn");
  });

  it("is 'warn' tone when the binary is unavailable", () => {
    const s: SpotifyStatus = { authorized: false, backend: "auto", deviceName: "d", binaryAvailable: false };
    expect(statusSummary(s, true).tone).toBe("warn");
  });

  it("is 'warn' tone when the binary exists but not authorized", () => {
    const s: SpotifyStatus = { authorized: false, backend: "auto", deviceName: "d", binaryAvailable: true };
    expect(statusSummary(s, true).tone).toBe("warn");
  });

  it("is 'ok' tone when enabled, authorized and the binary is available", () => {
    const summary = statusSummary(ok, true);
    expect(summary.tone).toBe("ok");
    expect(summary.label).toContain("go-librespot");
  });
});

describe("SPOTIFY_DISCLAIMER", () => {
  it("mentions the Premium + grey-area risk copy", () => {
    expect(SPOTIFY_DISCLAIMER).toContain("Premium");
    expect(SPOTIFY_DISCLAIMER.length).toBeGreaterThan(20);
  });

  // The disclaimer is compliance-critical: it must keep the Premium requirement,
  // the ToS grey-area / at-your-own-risk warning, the default-off promise, and the
  // "use your own developer credentials" notion. A refactor that drops any of these
  // must fail here rather than silently shipping weakened copy.
  it("retains every compliance-critical element (Premium, ToS/risk, default-off, own credentials)", () => {
    expect(SPOTIFY_DISCLAIMER).toContain("Premium");
    expect(SPOTIFY_DISCLAIMER).toContain("灰色地带"); // grey area of Spotify's ToS
    expect(SPOTIFY_DISCLAIMER).toContain("风险自负"); // at your own risk
    expect(SPOTIFY_DISCLAIMER).toContain("默认关闭"); // disabled by default
    expect(SPOTIFY_DISCLAIMER).toContain("凭据"); // your own developer app credentials
  });
});
