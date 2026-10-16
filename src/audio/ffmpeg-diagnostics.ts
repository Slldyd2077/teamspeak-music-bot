import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MAX_LINE_CHARS = 2048;
const MAX_TAIL_CHARS = 4096;

export interface FfmpegDiagnostics {
  getTail(): string;
}

/**
 * Drain independently of the PCM pipe: unread stderr can block FFmpeg even
 * when stdout is being consumed. Keep only complete, sanitized lines. Never
 * retain a suffix of an oversized raw line: it may have lost its URL/header
 * prefix and would no longer be possible to redact safely.
 */
export function collectFfmpegDiagnostics(stderr: Readable | null): FfmpegDiagnostics {
  let tail = "";
  let pending = "";
  let discardLine = false;
  let suppressHeaderContinuation = false;
  let previousCR = false;
  const decoder = new StringDecoder("utf8");

  const append = (text: string): void => {
    if (text) previousCR = false;
    if (discardLine) return;
    if (pending.length + text.length > MAX_LINE_CHARS) {
      pending = "";
      discardLine = true;
      return;
    }
    pending += text;
  };

  const finishLine = (): void => {
    if (discardLine) {
      tail = (tail + "[oversized diagnostic line omitted]\n").slice(-MAX_TAIL_CHARS);
      // An omitted line may be an authentication header. Omit folded values.
      suppressHeaderContinuation = true;
    } else if (pending) {
      const line = pending
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      const authHeader = /\b(?:cookie|set-cookie|authorization|proxy-authorization)\s*[:=]/i.test(line);
      if (authHeader || (suppressHeaderContinuation && /^\s/.test(line))) {
        tail = (tail + "[authentication header omitted]\n").slice(-MAX_TAIL_CHARS);
        suppressHeaderContinuation = true;
      } else {
        suppressHeaderContinuation = false;
        const sanitized = line
          // URLs and credentials can contain quotes or spaces. Keep the error
          // prefix only; guessing a closing delimiter could expose a suffix.
          .replace(/\b[a-z][a-z\d+.-]*:\/\/[\s\S]*/i, "[URL omitted]")
          // FFmpeg can also print a request target without the scheme/host.
          .replace(/\?[\s\S]*/, "?[query omitted]")
          .replace(/\bBearer\s+[\s\S]*/i, "Bearer [omitted]");
        tail = (tail + sanitized + "\n").slice(-MAX_TAIL_CHARS);
      }
    } else {
      suppressHeaderContinuation = false;
    }
    pending = "";
    discardLine = false;
  };

  const consume = (text: string): void => {
    const separators = /[\r\n]/g;
    let start = 0;
    for (let match = separators.exec(text); match; match = separators.exec(text)) {
      append(text.slice(start, match.index));
      if (match[0] === "\n" && previousCR) {
        previousCR = false;
      } else {
        finishLine();
        previousCR = match[0] === "\r";
      }
      start = match.index + 1;
    }
    append(text.slice(start));
  };

  stderr?.on("data", (chunk: Buffer) => consume(decoder.write(chunk)));
  stderr?.on("end", () => {
    consume(decoder.end());
    finishLine();
  });
  // Resume explicitly as attaching a listener does not resume an already
  // paused Readable. No player pause/backpressure operation touches stderr.
  stderr?.resume();

  return { getTail: () => tail.trimEnd() };
}
