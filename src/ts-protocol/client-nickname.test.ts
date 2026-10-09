import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { TS3Client } from "./client.js";

// A valid name reaches discovery, but these tests never open network sockets.
vi.mock("./protocol-detect.js", () => ({
  detectServerProtocol: vi.fn(async () => { throw new Error("discovery reached"); }),
}));

describe("TS3Client nickname length", () => {
  it.each(["1", "雪凌", "a".repeat(31), "中".repeat(31), "😀😀", "   "])(
    "rejects invalid nickname %s before discovery or UDP connection", async (nickname) => {
      const client = new TS3Client(
        { host: "invalid.test", port: 9987, queryPort: 10011, nickname },
        pino({ level: "silent" }),
      );
      await expect(client.connect()).rejects.toThrow("nickname must contain 3–30 characters");
    },
  );
  it.each(["abc", "a".repeat(30), "中文名", "中".repeat(30), "😀😀😀", "😀".repeat(30)])(
    "accepts boundary nickname %s measured in Unicode characters", async (nickname) => {
      const client = new TS3Client(
        { host: "invalid.test", port: 9987, queryPort: 10011, nickname },
        pino({ level: "silent" }),
      );
      await expect(client.connect()).rejects.toThrow("discovery reached");
    },
  );
});
