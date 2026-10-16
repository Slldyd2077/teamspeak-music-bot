import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { collectFfmpegDiagnostics } from "./ffmpeg-diagnostics.js";

async function finish(stream: PassThrough): Promise<void> {
  const ended = new Promise<void>((resolve) => stream.once("end", resolve));
  stream.end();
  await ended;
}

describe("bounded FFmpeg diagnostics", () => {
  for (const [label, line, expected] of [
    ["an apostrophe in the real FFmpeg URL error format", "Error opening input file http://127.0.0.1:9/audio?filename=artist's-song&api_key=quoted-secret.", "Error opening input file [URL omitted]"],
    ["a space in URL userinfo", 'Error opening input file https://user:space secret@cdn.example/audio?token=space-secret.', "Error opening input file [URL omitted]"],
    ["multiple URLs", 'Error opening inputs https://cdn.example/a?filename=artist\'s-song&key=first-secret and https://cdn.example/b?token=second-secret', "Error opening inputs [URL omitted]"],
    ["quotes and spaces in a request target", "GET /audio?filename=artist's song&api_key=request-secret HTTP/1.1", "GET /audio?[query omitted]"],
    ["an apostrophe in a Bearer value", "Token rejected Bearer prefix'quoted bearer-secret", "Token rejected Bearer [omitted]"],
  ]) {
    it(`omits the entire sensitive suffix after ${label}`, async () => {
      const stream = new PassThrough();
      const diagnostics = collectFfmpegDiagnostics(stream);
      stream.write(line + "\n");
      await finish(stream);
      expect(diagnostics.getTail()).toBe(expected);
    });
  }

  for (const splitDelimiter of [false, true]) {
    it(`omits folded authentication values with ${splitDelimiter ? "chunk-split" : "intact"} CRLF`, async () => {
      const stream = new PassThrough();
      const diagnostics = collectFfmpegDiagnostics(stream);
      stream.write(`Authorization: Basic header-secret\r${splitDelimiter ? "" : "\n"}`);
      if (splitDelimiter) stream.write("\n");
      stream.write("  continuation-secret\r\nHTTP error 401\r\n");
      await finish(stream);
      expect(diagnostics.getTail()).toContain("HTTP error 401");
      expect(diagnostics.getTail()).not.toContain("header-secret");
      expect(diagnostics.getTail()).not.toContain("continuation-secret");
    });
  }

  it("redacts URLs and headers split across arbitrary byte and UTF-8 boundaries", async () => {
    const stream = new PassThrough();
    const diagnostics = collectFfmpegDiagnostics(stream);
    const payload = Buffer.from("解码失败 https://user:user-secret@cdn.example/audio?token=query-secret#fragment-secret\rCookie: cookie-secret\nAuthorization: Bearer bearer-secret\nGET /audio?token=request-secret HTTP/1.1\nfinal error");
    for (const byte of payload) stream.write(Buffer.from([byte]));
    await finish(stream);
    expect(diagnostics.getTail()).toContain("解码失败");
    expect(diagnostics.getTail()).toContain("final error");
    for (const secret of ["user-secret", "query-secret", "fragment-secret", "cookie-secret", "bearer-secret", "request-secret"]) {
      expect(diagnostics.getTail()).not.toContain(secret);
    }
  });

  it("omits oversized raw lines without retaining an unsafe credential suffix", async () => {
    const stream = new PassThrough();
    const diagnostics = collectFfmpegDiagnostics(stream);
    stream.write("Cookie: " + "x".repeat(100000));
    stream.write("oversized-secret\r\n  folded-oversized-secret\r\nHTTP error 403\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diagnostics.getTail()).toContain("HTTP error 403");
    expect(diagnostics.getTail()).not.toContain("oversized-secret");
    stream.write("decoder warning\n".repeat(10000));
    stream.write("last useful error\n");
    await finish(stream);
    expect(diagnostics.getTail().length).toBeLessThanOrEqual(4096);
    expect(diagnostics.getTail()).toContain("last useful error");
    expect(diagnostics.getTail()).not.toContain("oversized-secret");
  });

  it("withholds an incomplete credential line until it can be safely sanitized", async () => {
    const stream = new PassThrough();
    const diagnostics = collectFfmpegDiagnostics(stream);
    stream.write("decoder warning\nhttps://user:partial-secret@");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diagnostics.getTail()).toContain("decoder warning");
    expect(diagnostics.getTail()).not.toContain("partial-secret");
    stream.write("cdn.example/audio?token=last-secret");
    await finish(stream);
    expect(diagnostics.getTail()).not.toContain("partial-secret");
    expect(diagnostics.getTail()).not.toContain("last-secret");
  });
});
