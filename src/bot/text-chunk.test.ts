import { describe, it, expect } from "vitest";
import { splitTextIntoChunks } from "./text-chunk.js";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("splitTextIntoChunks", () => {
  it("returns a single chunk for a short string", () => {
    const chunks = splitTextIntoChunks("hello world", 900);
    expect(chunks).toEqual(["hello world"]);
  });

  it("splits a multi-line string longer than maxBytes into multiple chunks on line boundaries", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line number ${i}`);
    const text = lines.join("\n");
    const chunks = splitTextIntoChunks(text, 60);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(60);
    }
    // No hard-split of any line occurred, so rejoining with "\n" is lossless.
    expect(chunks.join("\n")).toBe(text);
  });

  it("bounds by BYTES not chars: multibyte (Chinese) content stays under the cap", () => {
    // Each Chinese char is 3 bytes in UTF-8. 40 chars/line = 120 bytes/line.
    const lines = Array.from({ length: 10 }, () => "歌词".repeat(20));
    const text = lines.join("\n");
    const chunks = splitTextIntoChunks(text, 150);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(150);
    }
    expect(chunks.join("\n")).toBe(text);
  });

  it("hard-splits a single over-long line so no chunk exceeds the cap", () => {
    const longLine = "a".repeat(500);
    const chunks = splitTextIntoChunks(longLine, 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(100);
    }
    // Content is preserved (hard-split introduces split points, not \n).
    expect(chunks.join("")).toBe(longLine);
  });

  it("never splits a multibyte character across a hard-split boundary", () => {
    // 200 Chinese chars = 600 bytes on ONE line, cap 40 bytes.
    const longLine = "歌".repeat(200);
    const chunks = splitTextIntoChunks(longLine, 40);

    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(40);
      // A clean re-decode: every chunk is valid UTF-8 with no replacement char.
      expect(c.includes("�")).toBe(false);
    }
    expect(chunks.join("")).toBe(longLine);
  });

  it("preserves blank lines within a single chunk", () => {
    const text = "a\n\nb";
    expect(splitTextIntoChunks(text, 900)).toEqual([text]);
  });
});
