// src/music/spotify/backend.ts
// Type contract for the Spotify audio backend (go-librespot sidecar).
// Interface-only: this module intentionally contains NO runtime code so it
// can be imported for types by go-librespot.ts and controller.ts without
// pulling in child_process/ws/ffmpeg at type-check time.

/** Emitted when the currently playing Spotify track finishes or is stopped. */
export interface SpotifyTrackEndedEvent {
  uri: string;
  reason: "ended" | "stopped" | "error";
}

/** Now-playing metadata surfaced from the go-librespot "metadata" event. */
export interface SpotifyNowPlaying {
  uri: string;
  name: string;
  artist: string;
  album: string;
  coverUrl: string;
  durationMs: number;
}

/**
 * Long-lived Spotify audio source: owns the go-librespot sidecar + FIFO->ffmpeg
 * PCM pipe and exposes transport control plus a continuous 48kHz s16le stereo
 * PCM stream to feed AudioPlayer.playPcmStream().
 */
export interface SpotifyAudioBackend {
  start(): Promise<void>;
  stop(): void;
  isReady(): boolean;
  playTrack(uri: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  getPcmStream(): import("node:stream").Readable;
  getPositionMs(): number;
  on(event: "trackEnded", cb: (e: SpotifyTrackEndedEvent) => void): void;
  on(event: "metadata", cb: (m: SpotifyNowPlaying) => void): void;
  on(event: "ready" | "error", cb: (arg?: unknown) => void): void;
}
