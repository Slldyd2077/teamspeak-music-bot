// Empirically tests whether the browser UA + Referer headers fix the
// connection resets we saw in bot.log against m701/m801.music.126.net.
//
// Spawns ffmpeg twice against the SAME fresh Netease CDN URL:
//   A) old args from before the fix (no headers, -reconnect_delay_max 5)
//   B) new args from after the fix (browser UA + Referer for music.126.net)
// and reports bytes received + exit code + stderr-tail for each.

import { spawn } from "node:child_process";
import { buildFfmpegArgs } from "../dist/audio/player.js";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/test_netease_ua_fix.mjs <netease_cdn_url>");
  process.exit(2);
}

const FFMPEG = "ffmpeg";
const TIMEOUT_MS = 15_000;

function legacyArgs(u) {
  return [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-i", u,
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "-acodec", "pcm_s16le",
    "-",
  ];
}

function runFfmpeg(label, args) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0;
    let stderrTail = "";
    let killed = false;

    proc.stdout.on("data", (chunk) => {
      bytes += chunk.length;
    });
    proc.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1500);
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, TIMEOUT_MS);

    proc.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ label, bytes, code, signal, killed, stderrTail });
    });
  });
}

console.log(`URL: ${url}\n`);

const a = await runFfmpeg("A) legacy args (no UA)", legacyArgs(url));
console.log(`[A] code=${a.code} signal=${a.signal} killed=${a.killed} bytes=${a.bytes}`);
console.log(`    stderr-tail:\n${a.stderrTail.split("\n").slice(-6).map((l) => "    " + l).join("\n")}\n`);

const b = await runFfmpeg("B) fixed args (browser UA + Referer)", buildFfmpegArgs(url, 0));
console.log(`[B] code=${b.code} signal=${b.signal} killed=${b.killed} bytes=${b.bytes}`);
console.log(`    stderr-tail:\n${b.stderrTail.split("\n").slice(-6).map((l) => "    " + l).join("\n")}\n`);

const aFailed = a.bytes === 0 && !a.killed && a.code !== 0;
const bWorked = b.bytes > 100_000; // got real audio bytes
console.log(`Verdict: legacy ${aFailed ? "FAILED (no bytes, exit code 1)" : "??"} ; fixed ${bWorked ? "WORKED (received audio)" : "??"}`);
