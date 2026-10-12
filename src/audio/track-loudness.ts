import { spawn } from "node:child_process";

export interface LoudnessMeasurement {
  integratedLufs: number;
  truePeakDb: number;
}

export interface TrackNormalizationStatus {
  state: "disabled" | "analyzing" | "applied" | "failed" | "unavailable";
  gainDb: number;
  integratedLufs?: number;
  truePeakDb?: number;
}

/** One gain for the whole programme. Peak headroom takes precedence over target loudness. */
export function calculateTrackGainDb(measured: LoudnessMeasurement, targetLufs: number): number {
  if (measured.integratedLufs === -Infinity && measured.truePeakDb === -Infinity) return 0;
  if (!Number.isFinite(measured.integratedLufs) || !Number.isFinite(measured.truePeakDb) || !Number.isFinite(targetLufs)) {
    throw new Error("Invalid track loudness measurement");
  }
  return Math.min(targetLufs - measured.integratedLufs, -1 - measured.truePeakDb, 12);
}

export function parseLoudnessMeasurement(stderr: string): LoudnessMeasurement {
  // Only the final summary describes the complete programme, not a frame log
  // or the empty summary emitted when the filter is initialized.
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const integrated = summary.match(/Integrated loudness:\s+I:\s+(-?\d+(?:\.\d+)?|-inf)\s+LUFS/);
  const peak = summary.match(/True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?|-inf)\s+dBFS/);
  if (!integrated || !peak) throw new Error("Track loudness measurement missing");
  // ebur128 reports the absolute gate (-70 LUFS) for an all-silent programme.
  if (peak[1] === "-inf" && (integrated[1] === "-inf" || Number(integrated[1]) === -70)) {
    return { integratedLufs: -Infinity, truePeakDb: -Infinity };
  }
  const measured = {
    integratedLufs: Number(integrated[1]),
    truePeakDb: Number(peak[1]),
  };
  // Too-short or below-gate non-silent audio has no valid integrated reading.
  if (measured.integratedLufs <= -70) throw new Error("Invalid track loudness measurement");
  calculateTrackGainDb(measured, -18);
  return measured;
}

export function buildLoudnessAnalysisArgs(playbackArgs: string[]): string[] {
  const outputStart = playbackArgs.lastIndexOf("-f");
  if (outputStart < 0) throw new Error("Playback output format missing");
  const input = playbackArgs.slice(0, outputStart);
  // Analysis must finish at the real EOF. Playback's CDN recovery policy can
  // otherwise keep reconnecting after a complete file and suppress the summary.
  const reconnectAtEof = input.indexOf("-reconnect_at_eof");
  if (reconnectAtEof >= 0) input.splice(reconnectAtEof, 2);
  return [
    "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", ...input,
    "-vn", "-sn", "-dn", "-map", "0:a:0",
    // Measure only: loudnorm also normalizes discarded output at 192 kHz.
    // ebur128 retains BS.1770 gating and oversampled true-peak measurement.
    "-af", "aformat=sample_rates=48000:channel_layouts=stereo,ebur128=peak=true:framelog=verbose",
    "-f", "null", "-",
  ];
}

/** Full-file BS.1770 measurement, cached by exact source URL and never adjusted while playing. */
export class TrackLoudnessAnalyzer {
  private readonly cache = new Map<string, { measured: LoudnessMeasurement; expires: number }>();

  async measure(command: string, cacheKey: string, playbackArgs: string[], signal: AbortSignal): Promise<LoudnessMeasurement> {
    signal.throwIfAborted();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.measured;
    const measured = await new Promise<LoudnessMeasurement>((resolve, reject) => {
      let tail = "";
      const child = spawn(command, buildLoudnessAnalysisArgs(playbackArgs), {
        stdio: ["ignore", "ignore", "pipe"],
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        killSignal: "SIGKILL",
      });
      child.stderr.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-16384); });
      // Spawn errors can contain signed URLs; expose a fixed diagnostic only.
      child.once("error", () => reject(new Error("Track loudness analysis interrupted or unavailable")));
      child.once("close", (code) => {
        if (code !== 0) { reject(new Error("Track loudness analysis failed")); return; }
        try { resolve(parseLoudnessMeasurement(tail)); } catch (error) { reject(error); }
      });
    });
    signal.throwIfAborted();
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, { measured, expires: Date.now() + 15 * 60_000 });
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return measured;
  }
}
