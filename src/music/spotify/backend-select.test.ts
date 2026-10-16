import { describe, it, expect } from "vitest";
import { resolveSpotifyBackendKind as pick } from "./backend-select.js";
describe("resolveSpotifyBackendKind", () => {
  it("auto: go present -> go-librespot", () => expect(pick("auto", true, true)).toBe("go-librespot"));
  it("auto: go absent, rust present -> librespot", () => expect(pick("auto", false, true)).toBe("librespot"));
  it("auto: neither -> null", () => expect(pick("auto", false, false)).toBeNull());
  it("go-librespot: present -> go-librespot", () => expect(pick("go-librespot", true, true)).toBe("go-librespot"));
  it("go-librespot: absent -> null even if rust present", () => expect(pick("go-librespot", false, true)).toBeNull());
  it("librespot: present -> librespot", () => expect(pick("librespot", true, true)).toBe("librespot"));
  it("librespot: absent -> null even if go present", () => expect(pick("librespot", true, false)).toBeNull());
  it("auto default fallthrough matches auto", () => expect(pick("auto", true, false)).toBe("go-librespot"));
});
