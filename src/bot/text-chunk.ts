/**
 * Split `text` into chunks whose UTF-8 byte length never exceeds `maxBytes`.
 *
 * TeamSpeak enforces a per-message byte cap (~1024 bytes), and the send path
 * does no chunking, so a long single reply (e.g. full song lyrics) would be
 * truncated or rejected. This packs whole lines greedily, breaking BETWEEN
 * lines. When a single line is itself longer than `maxBytes`, it is hard-split
 * on UTF-8 character boundaries so no chunk ever exceeds the cap and no
 * multibyte character is ever cut in half.
 *
 * Content is preserved on rejoin, modulo the split points: chunks split only on
 * newline boundaries rejoin losslessly with `chunks.join("\n")`; a hard-split
 * long line rejoins with `chunks.join("")`.
 *
 * @param text     The full message text.
 * @param maxBytes Max UTF-8 bytes per chunk (default 900 — under TS's ~1024 cap
 *                 with headroom for protocol framing/escaping).
 */
export function splitTextIntoChunks(text: string, maxBytes = 900): string[] {
  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current !== "") {
      chunks.push(current);
      current = "";
    }
  };

  for (const rawLine of text.split("\n")) {
    const pieces =
      Buffer.byteLength(rawLine, "utf8") > maxBytes
        ? hardSplitByBytes(rawLine, maxBytes)
        : [rawLine];

    for (const piece of pieces) {
      const candidate = current === "" ? piece : `${current}\n${piece}`;
      if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
        current = candidate;
      } else {
        // current is guaranteed non-empty here: pieces never exceed maxBytes,
        // so an empty `current` always accepts the next piece above.
        flush();
        current = piece;
      }
    }
  }

  flush();
  return chunks;
}

/**
 * Break a single line into pieces each ≤ `maxBytes` UTF-8 bytes, never cutting
 * a character (iterates code points, so surrogate pairs stay intact).
 */
function hardSplitByBytes(line: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (currentBytes + chBytes > maxBytes && current !== "") {
      pieces.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  if (current !== "") pieces.push(current);
  return pieces;
}
