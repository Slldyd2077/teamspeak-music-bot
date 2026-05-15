#!/usr/bin/env node

/**
 * Download native binaries (ffmpeg + @discordjs/opus) from npmmirror CDN.
 * Called by setup.bat after npm install --ignore-scripts.
 *
 * Usage: node scripts/download-binaries.mjs [cdn_base_url]
 */

import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { get } from "node:https";
import { Readable } from "node:stream";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CDN = process.argv[2] || "https://cdn.npmmirror.com/binaries";
const PLATFORM = process.platform;
const ARCH = process.arch;
const NODE_ABI = process.versions.modules;

function download(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: 120000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function log(msg) {
  console.log(`  [binary] ${msg}`);
}

function isValidSize(filePath, minBytes) {
  try { return statSync(filePath).size >= minBytes; } catch { return false; }
}

async function downloadFfmpeg() {
  const ffDir = join(ROOT, "node_modules", "ffmpeg-static");
  const ffName = PLATFORM === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const ffDest = join(ffDir, ffName);

  if (!existsSync(ffDir)) { log("ffmpeg-static not installed, skipping"); return false; }
  if (existsSync(ffDest)) {
    if (isValidSize(ffDest, 50 * 1024 * 1024)) {
      log("ffmpeg already exists, skipping");
      return true;
    }
    log("ffmpeg exists but seems corrupted (too small), re-downloading...");
  }

  const url = `${CDN}/ffmpeg-static/b6.1.1/ffmpeg-${PLATFORM}-${ARCH}.gz`;
  log("Downloading ffmpeg...");
  const buf = await download(url);
  await pipeline(Readable.from(buf), createGunzip(), createWriteStream(ffDest));
  try { execSync(`chmod +x "${ffDest}"`); } catch {}
  const size = ((await statSync(ffDest)).size / 1024 / 1024).toFixed(1);
  log(`ffmpeg OK (${size} MB)`);
  return true;
}

async function downloadOpus() {
  const opusDir = join(ROOT, "node_modules", "@discordjs", "opus");
  const prebuildName = `node-v${NODE_ABI}-napi-v3-${PLATFORM}-${ARCH}-unknown-unknown`;
  const opusDest = join(opusDir, "prebuild", prebuildName, "opus.node");

  if (!existsSync(opusDir)) { log("@discordjs/opus not installed, skipping"); return false; }
  if (existsSync(opusDest)) {
    if (isValidSize(opusDest, 100 * 1024)) {
      log("@discordjs/opus already exists, skipping");
      return true;
    }
    log("@discordjs/opus exists but seems corrupted (too small), re-downloading...");
  }

  const url = `${CDN}/@discordjs/opus/v0.10.0/opus-v0.10.0-node-v${NODE_ABI}-napi-v3-${PLATFORM}-${ARCH}-unknown-unknown.tar.gz`;
  log("Downloading @discordjs/opus...");
  try {
    const buf = await download(url);
    mkdirSync(dirname(opusDest), { recursive: true });
    const require = createRequire(import.meta.url);
    const tar = require("tar");
    const tmpFile = join(tmpdir(), `discordjs-opus-${Date.now()}.tar.gz`);
    writeFileSync(tmpFile, buf);
    await tar.extract({ cwd: join(opusDir, "prebuild"), file: tmpFile });
    log("@discordjs/opus OK");
    return true;
  } catch (err) {
    log(`CDN download failed (${err.message}), trying to build from source...`);
    try {
      execSync("npm rebuild @discordjs/opus", { cwd: ROOT, stdio: "inherit" });
      if (existsSync(opusDest) && isValidSize(opusDest, 100 * 1024)) {
        log("@discordjs/opus built from source OK");
        return true;
      }
      log("Source build completed but .node file not found");
      return false;
    } catch (buildErr) {
      log(`Source build failed: ${buildErr.message}`);
      log("Install build tools: sudo apt install build-essential (Ubuntu/Debian)");
      log("                    sudo yum groupinstall 'Development Tools' (CentOS/RHEL)");
      return false;
    }
  }
}

async function downloadBetterSqlite3() {
  const pkgDir = join(ROOT, "node_modules", "better-sqlite3");
  const dest = join(pkgDir, "build", "Release", "better_sqlite3.node");

  if (!existsSync(pkgDir)) { log("better-sqlite3 not installed, skipping"); return false; }
  if (existsSync(dest)) {
    if (isValidSize(dest, 500 * 1024)) {
      log("better-sqlite3 already exists, skipping");
      return true;
    }
    log("better-sqlite3 exists but seems corrupted (too small), re-downloading...");
  }

  const version = "12.8.0";
  const url = `${CDN}/better-sqlite3/v${version}/better-sqlite3-v${version}-node-v${NODE_ABI}-${PLATFORM}-${ARCH}.tar.gz`;
  log("Downloading better-sqlite3...");
  const buf = await download(url);
  const require = createRequire(import.meta.url);
  const tar = require("tar");
  const tmpFile = join(tmpdir(), `better-sqlite3-${Date.now()}.tar.gz`);
  writeFileSync(tmpFile, buf);
  mkdirSync(dirname(dest), { recursive: true });
  await tar.extract({ cwd: pkgDir, file: tmpFile });
  if (existsSync(dest)) {
    log(`better-sqlite3 OK (${((await statSync(dest)).size / 1024).toFixed(0)} KB)`);
    return true;
  }
  log("better-sqlite3 extracted but .node file not found at expected path");
  return false;
}

try {
  const results = await Promise.all([downloadFfmpeg(), downloadOpus(), downloadBetterSqlite3()]);
  if (results.some(Boolean)) {
    console.log("  [binary] All downloads complete");
  }
} catch (e) {
  console.error(`  [binary] ERROR: ${e.message}`);
  process.exit(1);
}

