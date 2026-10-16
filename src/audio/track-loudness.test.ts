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
  it("parses only the final full-programme summary, including true rather than sample peaks", () => {
    const summary = 'Summary:\n Integrated loudness:\n I: -25.2 LUFS\n Sample peak:\n Peak: -9.1 dBFS\n True peak:\n Peak: -6.3 dBFS';
    expect(parseLoudnessMeasurement(`Summary:\n Integrated loudness:\n I: -70.0 LUFS\n True peak:\n Peak: -inf dBFS\n${summary}`)).toEqual({ integratedLufs: -25.2, truePeakDb: -6.3 });
    expect(() => parseLoudnessMeasurement(summary.replace('-25.2', 'NaN'))).toThrow();
    expect(() => parseLoudnessMeasurement(summary.replace('True peak:', 'Other peak:'))).toThrow();
    expect(() => parseLoudnessMeasurement(summary.replace('-25.2', '-70.0'))).toThrow();
    expect(() => parseLoudnessMeasurement(`${summary}\nSummary:\n incomplete`)).toThrow();
    expect(parseLoudnessMeasurement('Summary:\n Integrated loudness:\n I: -70.0 LUFS\n True peak:\n Peak: -inf dBFS')).toEqual({ integratedLufs: -Infinity, truePeakDb: -Infinity });
    expect(() => parseLoudnessMeasurement('missing measurement')).toThrow();
  });
  it("analyzes the full stereo programme without seeking and discards the analysis audio", () => {
    const args = buildLoudnessAnalysisArgs(buildFfmpegArgs('https://music.126.net/song', 0));
    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-reconnect_at_eof');
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
    expect(args[args.indexOf('-af') + 1]).toContain('ebur128=peak=true');
    expect(args.join(' ')).not.toContain('loudnorm');
    expect(args[args.indexOf('-af') + 1]).toContain('channel_layouts=stereo');
  });
  it("uses only a constant volume filter during playback, including seeking", () => {
    const args = buildFfmpegArgs('/song.wav', 45, { trackGainDb: -8 });
    expect(args[args.indexOf('-af') + 1]).toBe('volume=-8dB');
    expect(args.join(' ')).not.toMatch(/loudnorm|dynaudnorm|compressor|limiter/);
    expect(buildFfmpegArgs('/microphone', 0, { realtime: true, trackGainDb: 8 })).not.toContain('-af');
  });
});

describe("player analyzes in the background and smoothly applies track gain", () => {
  function player(analyze: (url: string, signal: AbortSignal) => Promise<{ integratedLufs: number; truePeakDb: number }>) {
    const p = new AudioPlayer(pino({ level: 'silent' }), { analyzeTrackLoudness: analyze });
    const spawn = vi.spyOn(p as unknown as { spawnUrlPlayback: (...args: unknown[]) => void }, 'spawnUrlPlayback').mockImplementation(() => {
      const playback = p as unknown as { state: string; ffmpeg: unknown };
      playback.state = 'playing';
      playback.ffmpeg = { pid: undefined };
    });
    p.setLoudnessNormalization({ enabled: true, targetLufs: -18 });
    return { p, spawn };
  }
  it("setting changes, pauses and seeking do not change a playing song's gain", async () => {
    const analyze = vi.fn(async () => ({ integratedLufs: -9, truePeakDb: -0.1 }));
    const { p, spawn } = player(analyze);
    try {
      p.play('/first.wav');
      await vi.waitFor(() => expect(p.getLoudnessNormalization().state).toBe('applied'));
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
  it("starts immediately, cancels analysis on stop and ignores stale results", async () => {
    let finish!: (value: { integratedLufs: number; truePeakDb: number }) => void;
    let signal!: AbortSignal;
    const { p, spawn } = player(async (_url, currentSignal) => {
      signal = currentSignal;
      return new Promise((resolve) => { finish = resolve });
    });
    p.play('/first.wav');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(p.getLoudnessNormalization().state).toBe('analyzing');
    p.stop();
    expect(signal.aborted).toBe(true);
    finish({ integratedLufs: -9, truePeakDb: -0.1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(p.getLoudnessNormalization()).toEqual({ state: 'disabled', gainDb: 0 });
  });
  it("failed measurement plays the original gain and reports the failure", async () => {
    const { p, spawn } = player(async () => { throw new Error('scan failed') });
    try {
      p.play('/first.wav');
      expect(spawn).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(p.getLoudnessNormalization().state).toBe('failed'));
      expect(p.getLoudnessNormalization()).toEqual({ state: 'failed', gainDb: 0 });
    } finally { p.stop(); }
  });
  it("seeks during analysis without cancelling or remeasuring the complete source", async () => {
    let finish!: (value: { integratedLufs: number; truePeakDb: number }) => void;
    let signal!: AbortSignal;
    const analyze = vi.fn(async (_url: string, currentSignal: AbortSignal) => {
      signal = currentSignal;
      return new Promise<{ integratedLufs: number; truePeakDb: number }>(resolve => { finish = resolve });
    });
    const { p, spawn } = player(analyze);
    try {
      p.play('/first.wav');
      p.seek(35);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls.at(-1)?.[1]).toBe(35);
      expect(signal.aborted).toBe(false);
      expect(analyze).toHaveBeenCalledTimes(1);
      finish({ integratedLufs: -9, truePeakDb: -0.1 });
      await vi.waitFor(() => expect(p.getLoudnessNormalization().state).toBe('applied'));
      expect(p.getLoudnessNormalization().gainDb).toBe(-9);
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { p.stop(); }
  });
  it.each([-9, 9])("ramps %i dB over five seconds of audible music, preserving seeks and pauses", async gainDb => {
    const { p } = player(async () => ({ integratedLufs: -18 - gainDb, truePeakDb: -20 }));
    const internals = p as unknown as {
      pcmBuffer: Buffer; sendNextFrame(): void; encoder: { encode(pcm: Buffer): Buffer };
      applyVolume(pcm: Buffer): Buffer;
    };
    const encoded: Buffer[] = [];
    vi.spyOn(internals.encoder, 'encode').mockImplementation(pcm => { encoded.push(pcm); return Buffer.alloc(1) });
    const pcm = Buffer.alloc(3840);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(5000, i);
    const frame = () => { internals.pcmBuffer = Buffer.from(pcm); internals.sendNextFrame(); return encoded.at(-1)! };
    try {
      p.setVolume(100);
      p.play('/first.wav');
      await vi.waitFor(() => expect(p.getLoudnessNormalization().state).toBe('applied'));
      expect(frame().readInt16LE(0)).toBe(5000);
      for (let i = 1; i < 125; i++) frame();
      p.pause();
      for (let i = 0; i < 250; i++) frame();
      p.resume();
      p.seek(30);
      const middle = frame();
      expect(middle.readInt16LE(0)).toBeCloseTo(Math.round(5000 * 10 ** (gainDb / 40)), 0);
      expect(middle.readInt16LE(0)).toBe(middle.readInt16LE(2));
      expect(Math.abs(middle.readInt16LE(4) - middle.readInt16LE(0))).toBeLessThanOrEqual(1);
      for (let i = 126; i < 250; i++) frame();
      expect(frame().readInt16LE(0)).toBe(Math.round(5000 * 10 ** (gainDb / 20)));
      // Entrance effects only receive user volume and ducking, never song gain.
      expect(internals.applyVolume(pcm).readInt16LE(0)).toBe(5000);
      p.setDuckingGain(0.5);
      expect(frame().readInt16LE(0)).toBe(Math.round(2500 * 10 ** (gainDb / 20)));
      p.play('/second.wav', 0, 0, { realtime: true });
      expect(frame().readInt16LE(0)).toBe(2500);
    } finally { p.stop(); }
  });
  it("switching songs prevents the previous analysis from changing the new song", async () => {
    let finish!: (value: { integratedLufs: number; truePeakDb: number }) => void;
    const { p } = player(async () => new Promise(resolve => { finish = resolve }));
    p.play('/first.wav');
    p.setLoudnessNormalization({ enabled: false, targetLufs: -18 });
    p.play('/second.wav');
    finish({ integratedLufs: -9, truePeakDb: -0.1 });
    await new Promise(resolve => setImmediate(resolve));
    expect(p.getLoudnessNormalization()).toEqual({ state: 'disabled', gainDb: 0 });
    p.stop();
  });
  it("does not wait for background analysis at playback EOF", async () => {
    let finish!: (value: { integratedLufs: number; truePeakDb: number }) => void;
    let signal!: AbortSignal;
    const { p } = player(async (_url, currentSignal) => {
      signal = currentSignal;
      return new Promise(resolve => { finish = resolve });
    });
    const ended = vi.fn();
    p.on('trackEnd', ended);
    p.play('/first.wav');
    const internals = p as unknown as { ffmpeg: unknown; startFrameLoop(): void };
    internals.ffmpeg = null;
    internals.startFrameLoop();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    expect(signal.aborted).toBe(true);
    finish({ integratedLufs: -9, truePeakDb: -0.1 });
    await new Promise(resolve => setImmediate(resolve));
    p.stop();
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

it("real playback emits music before the scan finishes and reaches its gain without restarting FFmpeg", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsmusic-background-test-'));
  const wave = join(dir, 'music.wav');
  const command = getFfmpegCommand();
  let finish!: (value: { integratedLufs: number; truePeakDb: number }) => void;
  const analyze = vi.fn(async () => new Promise<{ integratedLufs: number; truePeakDb: number }>(resolve => { finish = resolve }));
  const p = new AudioPlayer(pino({ level: 'silent' }), { analyzeTrackLoudness: analyze });
  const frames: Buffer[] = [];
  const internals = p as unknown as { encoder: { encode(pcm: Buffer): Buffer }; ffmpeg: unknown };
  vi.spyOn(internals.encoder, 'encode').mockImplementation(pcm => { frames.push(Buffer.from(pcm)); return Buffer.alloc(1) });
  function rms(pcm: Buffer) {
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
    return Math.sqrt(sum / (pcm.length / 2));
  }
  try {
    expect(spawnSync(command, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=8', '-y', wave], { stdio: 'ignore' }).status).toBe(0);
    p.setVolume(100);
    p.setLoudnessNormalization({ enabled: true, targetLufs: -18 });
    p.play(wave, 0, 8);
    const decoder = internals.ffmpeg;
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(3));
    expect(p.getLoudnessNormalization().state).toBe('analyzing');
    const original = rms(frames.at(-1)!);
    const firstAdjusted = frames.length;
    finish({ integratedLufs: -27, truePeakDb: -14 });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(firstAdjusted + 260), { timeout: 7000 });
    expect(20 * Math.log10(rms(frames.at(-1)!) / original)).toBeCloseTo(9, 1);
    expect(internals.ffmpeg === decoder || internals.ffmpeg === null).toBe(true);
    expect(analyze).toHaveBeenCalledTimes(1);
    for (let i = firstAdjusted + 1; i < firstAdjusted + 249; i++) {
      expect(Math.abs(20 * Math.log10(rms(frames[i]!) / rms(frames[i - 1]!)))).toBeLessThan(0.1);
    }
  } finally { p.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 10_000);

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
    expect(await analyzer.measure(getFfmpegCommand(), url, buildFfmpegArgs(url, 0), AbortSignal.timeout(8000))).toEqual(measured);
    expect(requests).toBe(1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 10_000);

it('measures intersample peaks and leaves real silence at zero gain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsmusic-peak-test-'));
  const command = getFfmpegCommand();
  const analyzer = new TrackLoudnessAnalyzer();
  try {
    for (const silent of [false, true]) {
      const wave = join(dir, `${silent}.wav`);
      // At 12 kHz the samples miss the waveform peaks by about 3 dB.
      const source = silent ? 'anullsrc=r=48000:cl=stereo' : 'aevalsrc=0.5*sin(2*PI*12000*t+PI/4)|0.5*sin(2*PI*12000*t+PI/4):s=48000';
      expect(spawnSync(command, ['-v', 'error', '-f', 'lavfi', '-i', source, '-t', '2', '-y', wave], { stdio: 'ignore' }).status).toBe(0);
      const measured = await analyzer.measure(command, wave, buildFfmpegArgs(wave, 0), AbortSignal.timeout(8000));
      if (silent) {
        expect(measured).toEqual({ integratedLufs: -Infinity, truePeakDb: -Infinity });
        expect(calculateTrackGainDb(measured, -18)).toBe(0);
      } else {
        expect(measured.truePeakDb).toBeGreaterThan(-7);
        expect(measured.truePeakDb).toBeLessThan(-5);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 10_000);

it.each([44100, 48000, 96000])('matches reference measurements for a steady mono source at %i Hz', async (rate) => {
  const dir = mkdtempSync(join(tmpdir(), 'tsmusic-reference-test-'));
  const command = getFfmpegCommand();
  const wave = join(dir, 'steady.wav');
  try {
    expect(spawnSync(command, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=${rate}:duration=4`, '-y', wave], { stdio: 'ignore' }).status).toBe(0);
    const measured = await new TrackLoudnessAnalyzer().measure(command, wave, buildFfmpegArgs(wave, 0), AbortSignal.timeout(8000));
    const reference = spawnSync(command, ['-nostats', '-i', wave, '-af', 'aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=-18:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
    expect(reference.status).toBe(0);
    const legacy = JSON.parse(reference.stderr.match(/\{\s*"input_i"[^}]+\}/)![0]);
    expect(Math.abs(measured.integratedLufs - Number(legacy.input_i))).toBeLessThan(0.15);
    expect(Math.abs(measured.truePeakDb - Number(legacy.input_tp))).toBeLessThan(0.15);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 10_000);
