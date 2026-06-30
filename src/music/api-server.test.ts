import { describe, it, expect } from "vitest";
import { describeQqApiStartupError } from "./api-server.js";

describe("describeQqApiStartupError", () => {
  it("flags ERR_REQUIRE_ESM by error code with version-pin guidance", () => {
    const hint = describeQqApiStartupError({ code: "ERR_REQUIRE_ESM", message: "..." });
    expect(hint).toMatch(/ERR_REQUIRE_ESM/);
    expect(hint).toMatch(/~2\.4\.0/);
    expect(hint).toMatch(/~2\.2\.10/);
  });

  it("flags ERR_REQUIRE_ESM by message when the code is absent", () => {
    const hint = describeQqApiStartupError(
      new Error("require() of ES Module .../@sansenjian/qq-music-api/dist/index.js not supported")
    );
    expect(hint).toMatch(/incompatible @sansenjian\/qq-music-api/);
  });

  it("flags a Node engine mismatch with a Node-upgrade hint", () => {
    const hint = describeQqApiStartupError(new Error("Unsupported engine: requires Node >=20.17"));
    expect(hint).toMatch(/Node >=20\.17/);
    expect(hint).toMatch(/~2\.2\.10/);
  });

  it("returns null for an unrelated startup error (falls back to the generic warning)", () => {
    expect(describeQqApiStartupError(new Error("EADDRINUSE: port in use"))).toBeNull();
    expect(describeQqApiStartupError(undefined)).toBeNull();
    expect(describeQqApiStartupError(null)).toBeNull();
  });
});
