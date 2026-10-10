import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import pino from "pino";
import { calculateTrackGainDb, parseLoudnessMeasurement, buildLoudnessAnalysisArgs } from "./track-loudness.js";
import { buildFfmpegArgs, AudioPlayer, getFfmpegCommand } from "./player.js";
import { TrackLoudnessAnalyzer } from "./track-loudness.js";

describe("track loudness normalization", () => {
  it("matches quiet and loud masters with one fixed gain for each whole track", () => {
    const quiet = calculateTrackGainDb({ integratedLufs: -27, truePeakDb: -14 }, -18);
    const loud = calculateTrackGainDb({ integratedLufs: -9, truePeakDb: -0.1 }, -18);
    expect(quiet).toBe(9);
    expect(loud).toBe(-9);
    expect(-27 + quiet).toBe(-18);
    expect(-9 + loud).toBe(-18);
    const factor = 10 ** (quiet / 20);
    expect((0.1 * factor) / (0.01 * factor)).toBeCloseTo(10, 12);
  });
  it("reduces the whole-track boost when peaks need headroom, rather than compressing the chorus", () => {
    expect(calculateTrackGainDb({ integratedLufs: -27, truePeakDb: -3 }, -18)).toBe(2);
    expect(calculateTrackGainDb({ integratedLufs: -60, truePeakDb: -50 }, -18)).toBe(12);
    expect(calculateTrackGainDb({ integratedLufs: -Infinity, truePeakDb: -Infinity }, -18)).toBe(0);
  });
  it("parses measured input loudness, not loudnorm's dynamically adjusted output", () => {
    expect(parseLoudnessMeasurement('log\n{"input_i":"-25.2","input_tp":"-6.3","output_i":"-18"}')).toEqual({ integratedLufs: -25.2, truePeakDb: -6.3 });
    expect(() => parseLoudnessMeasurement('{"input_i":"NaN","input_tp":"0"}')).toThrow();
    expect(() => parseLoudnessMeasurement('missing measurement')).toThrow();
  });
  it("analyzes the full stereo programme without seeking and discards the analysis audio", () => {
    const args = buildLoudnessAnalysisArgs(buildFfmpegArgs('https://music.126.net/song', 0));
    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-reconnect_at_eof');
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
    expect(args[args.indexOf('-af') + 1]).toContain('loudnorm');
    expect(args[args.indexOf('-af') + 1]).toContain('channel_layouts=stereo');
  });
  it("uses only a constant volume filter during playback, including seeking", () => {
    const args = buildFfmpegArgs('/song.wav', 45, { trackGainDb: -8 });
    expect(args[args.indexOf('-af') + 1]).toBe('volume=-8dB');
    expect(args.join(' ')).not.toMatch(/loudnorm|dynaudnorm|compressor|limiter/);
    expect(buildFfmpegArgs('/microphone', 0, { realtime: true, trackGainDb: 8 })).not.toContain('-af');
  });
});

describe("player freezes loudness gain at track boundaries", () => {
  function player(analyze: (url: string, signal: AbortSignal) => Promise<{ integratedLufs: number; truePeakDb: number }>) {
    const p = new AudioPlayer(pino({ level: 'silent' }), { analyzeTrackLoudness: analyze });
    const spawn = vi.spyOn(p as unknown as { spawnUrlPlayback: (...args: unknown[]) => void }, 'spawnUrlPlayback').mockImplementation(() => {});
    p.setLoudnessNormalization({ enabled: true, targetLufs: -18 });
    return { p, spawn };
  }
  it("setting changes, pauses and seeking do not change a playing song's gain", async () => {
    const analyze = vi.fn(async () => ({ integratedLufs: -9, truePeakDb: -0.1 }));
    const { p, spawn } = player(analyze);
    try {
      p.play('/first.wav');
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      expect(p.getLoudnessNormalization().gainDb).toBe(-9);
      p.setLoudnessNormalization({ enabled: false, targetLufs: -23 });
      p.pause(); p.resume();
      p.seek(35);
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(p.getLoudnessNormalization().gainDb).toBe(-9);
      expect(spawn.mock.calls.at(-1)?.[3]).toEqual({ trackGainDb: -9 });
      p.resumeTrack('/refreshed-cdn-url.wav', 42, 180);
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(p.getLoudnessNormalization().gainDb).toBe(-9);
      expect(spawn.mock.calls.at(-1)?.[3]).toEqual({ trackGainDb: -9 });
      p.play('/second.wav');
      expect(p.getLoudnessNormalization()).toEqual({ state: 'disabled', gainDb: 0 });
    } finally { p.stop(); }
  });
  it("stopping cancels analysis and stale results cannot start playback", async () => {
    let finish!: (value: { integratedLufs: number; truePeakDb: number }) => void;
    let signal!: AbortSignal;
    const { p, spawn } = player(async (_url, currentSignal) => {
      signal = currentSignal;
      return new Promise((resolve) => { finish = resolve });
    });
    p.play('/first.wav');
    expect(p.getLoudnessNormalization().state).toBe('analyzing');
    p.stop();
    expect(signal.aborted).toBe(true);
    finish({ integratedLufs: -9, truePeakDb: -0.1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).not.toHaveBeenCalled();
  });
  it("failed measurement plays the original gain and reports the failure", async () => {
    const { p, spawn } = player(async () => { throw new Error('scan failed') });
    try {
      p.play('/first.wav');
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      expect(p.getLoudnessNormalization()).toEqual({ state: 'failed', gainDb: 0 });
    } finally { p.stop(); }
  });
  it("an entrance-effect frame loop cannot advance the queue while track analysis is pending", async () => {
    let finish!: (value: { integratedLufs: number; truePeakDb: number }) => void;
    const { p } = player(async () => new Promise((resolve) => { finish = resolve }));
    const ended = vi.fn();
    p.on('trackEnd', ended);
    p.play('/first.wav');
    (p as unknown as { startFrameLoop(): void }).startFrameLoop();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(ended).not.toHaveBeenCalled();
    p.stop();
    finish({ integratedLufs: -9, truePeakDb: -0.1 });
  });
});

it("real FFmpeg equalizes two tracks while preserving the quiet/chorus ratio within each", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsmusic-loudness-test-'));
  const analyzer = new TrackLoudnessAnalyzer();
  const command = getFfmpegCommand();
  const peaks: number[] = [];
  const sourceRms: number[] = [];
  function rms(pcm: Buffer, start: number, end: number) {
    let energy = 0;
    for (let i = start; i < end; i++) energy += (pcm.readInt16LE(i * 4) / 32768) ** 2;
    return Math.sqrt(energy / (end - start));
  }
  try {
    for (const level of [0.12, 0.6]) {
      const pcm = Buffer.alloc(8 * 48000 * 4);
      for (let i = 0; i < 8 * 48000; i++) {
        const amplitude = i < 4 * 48000 ? level / 4 : level;
        const value = Math.round(amplitude * Math.sin(2 * Math.PI * 1000 * i / 48000) * 32767);
        pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2);
      }
      const file = join(dir, `${level}.s16le`);
      writeFileSync(file, pcm);
      const input = ['-nostats', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', file];
      const wave = join(dir, `${level}.wav`);
      expect(spawnSync(command, [...input, '-y', wave], { stdio: 'ignore' }).status).toBe(0);
      const measured = await analyzer.measure(command, wave, buildFfmpegArgs(wave, 0), new AbortController().signal);
      const gain = calculateTrackGainDb(measured, -18);
      const result = spawnSync(command, buildFfmpegArgs(wave, 0, { trackGainDb: gain }), { maxBuffer: 4 * 1024 * 1024 });
      expect(result.status).toBe(0);
      const rendered = result.stdout;
      const quiet = rms(rendered, 48000, 3 * 48000);
      const chorus = rms(rendered, 5 * 48000, 7 * 48000);
      expect(20 * Math.log10(chorus / quiet)).toBeCloseTo(20 * Math.log10(4), 1);
      peaks.push(chorus);
      sourceRms.push(rms(pcm, 5 * 48000, 7 * 48000));
      expect(chorus / rms(pcm, 5 * 48000, 7 * 48000)).toBeCloseTo(10 ** (gain / 20), 3);
    }
    expect(20 * Math.log10(sourceRms[1]! / sourceRms[0]!)).toBeGreaterThan(13);
    expect(Math.abs(20 * Math.log10(peaks[1]! / peaks[0]!))).toBeLessThan(0.2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

it('finishes full-file HTTP loudness analysis at EOF without replaying the source', async () => {
  let requests = 0;
  const pcm = Buffer.alloc(4 * 48000 * 4);
  for (let i = 0; i < 4 * 48000; i++) {
    const value = Math.round(Math.sin(2 * Math.PI * 1000 * i / 48000) * 6000);
    pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const wave = Buffer.concat([header, pcm]);
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wave.length });
    response.end(wave);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/whole-track.wav`;
    const analyzer = new TrackLoudnessAnalyzer();
    const measured = await analyzer.measure(getFfmpegCommand(), url, buildFfmpegArgs(url, 0), AbortSignal.timeout(8000));
    expect(Number.isFinite(measured.integratedLufs)).toBe(true);
    expect(requests).toBe(1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 10_000);
