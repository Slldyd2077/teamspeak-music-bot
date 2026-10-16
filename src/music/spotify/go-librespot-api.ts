import { EventEmitter } from "node:events";
import axios, { type AxiosInstance } from "axios";
import WebSocket from "ws";

export interface GoLibrespotStatusTrack {
  uri: string;
  name: string;
  artist_names: string[];
  album_name: string;
  album_cover_url: string | null;
  position: number;
  duration: number;
}

export interface GoLibrespotStatus {
  stopped: boolean;
  paused: boolean;
  buffering: boolean;
  track: GoLibrespotStatusTrack | null;
}

export class GoLibrespotRestClient {
  private http: AxiosInstance;

  constructor(baseUrl: string, deps?: { http?: AxiosInstance }) {
    this.http =
      deps?.http ??
      axios.create({
        baseURL: baseUrl,
        timeout: 10000,
        headers: { "Content-Type": "application/json" },
      });
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.http.get("/");
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async playTrack(uri: string): Promise<void> {
    await this.http.post("/player/play", { uri });
  }

  async pause(): Promise<void> {
    await this.http.post("/player/pause");
  }

  async resume(): Promise<void> {
    await this.http.post("/player/resume");
  }

  async stop(): Promise<void> {
    await this.http.post("/player/stop");
  }

  async seek(ms: number): Promise<void> {
    await this.http.post("/player/seek", { position: ms, relative: false });
  }

  async getStatus(): Promise<GoLibrespotStatus | null> {
    try {
      const res = await this.http.get("/status");
      const d = res.data ?? {};
      const t = d.track;
      return {
        stopped: Boolean(d.stopped),
        paused: Boolean(d.paused),
        buffering: Boolean(d.buffering),
        track: t
          ? {
              uri: t.uri ?? "",
              name: t.name ?? "",
              artist_names: Array.isArray(t.artist_names) ? t.artist_names : [],
              album_name: t.album_name ?? "",
              album_cover_url: t.album_cover_url ?? null,
              position: t.position ?? 0,
              duration: t.duration ?? 0,
            }
          : null,
      };
    } catch {
      return null;
    }
  }
}

export type GoLibrespotEventType =
  | "metadata"
  | "playing"
  | "paused"
  | "not_playing"
  | "stopped"
  | "will_play"
  | "seek"
  | "active"
  | "inactive"
  | "volume"
  | "playback_ready";

interface WsLike {
  on(event: string, cb: (...args: any[]) => void): void;
  close(): void;
}
type WebSocketCtor = new (url: string) => WsLike;

const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 10000;
// R4-5: a connection must stay up at least this long before we treat it as
// "stable" and reset the reconnect backoff. A socket that is accepted and then
// immediately closed (a flap) never reaches this, so the exponential backoff
// keeps growing instead of pinning the reconnect interval at INITIAL_RECONNECT_MS.
const STABLE_CONNECTION_MS = 5000;

/**
 * Emitted (in addition to the go-librespot event types) after the socket has
 * SUCCESSFULLY re-opened following a drop — never on the very first connect.
 * Consumers use it to re-query GET /status and reconcile any track-end that was
 * emitted by go-librespot during the WS-down window (R4-3).
 */
export type GoLibrespotSyntheticEvent = "reconnected";

export class GoLibrespotEventClient extends EventEmitter {
  private wsUrl: string;
  private WebSocketCtor: WebSocketCtor;
  private ws: WsLike | null = null;
  private stopped = false;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // R4-3: false until the FIRST successful open. A later open is therefore a
  // reconnect and warrants a "reconnected" re-sync signal.
  private hasConnected = false;
  // R4-5: fires STABLE_CONNECTION_MS after an open; only then is the backoff reset.
  private stableTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(wsUrl: string, deps?: { WebSocketCtor?: WebSocketCtor }) {
    super();
    this.wsUrl = wsUrl;
    this.WebSocketCtor = deps?.WebSocketCtor ?? (WebSocket as unknown as WebSocketCtor);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearStableTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new this.WebSocketCtor(this.wsUrl);
    this.ws = ws;
    ws.on("open", () => this.onOpen());
    ws.on("message", (buf: unknown) => this.handleMessage(buf));
    ws.on("close", () => {
      this.ws = null;
      // R4-5: the connection is gone — cancel the pending stability reset so a
      // short-lived (flapping) socket never resets the backoff.
      this.clearStableTimer();
      this.scheduleReconnect();
    });
    ws.on("error", (err: unknown) => {
      if (this.listenerCount("error") > 0) this.emit("error", err);
    });
  }

  private onOpen(): void {
    // R4-3: only a RE-open (a socket that had connected before, then dropped)
    // needs reconciliation; the initial connect has nothing to catch up on.
    const isReconnect = this.hasConnected;
    this.hasConnected = true;
    // R4-5: do NOT reset the backoff here. Arm a timer that resets it only once
    // the connection has stayed up for STABLE_CONNECTION_MS; a flap that closes
    // before then leaves the exponential backoff to keep growing.
    this.armStableTimer();
    if (isReconnect) this.emit("reconnected");
  }

  private armStableTimer(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.reconnectDelay = INITIAL_RECONNECT_MS;
    }, STABLE_CONNECTION_MS);
    (this.stableTimer as { unref?: () => void }).unref?.();
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private handleMessage(buf: unknown): void {
    let parsed: unknown;
    try {
      const text = Buffer.isBuffer(buf)
        ? buf.toString("utf8")
        : typeof buf === "string"
          ? buf
          : String(buf);
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed && typeof (parsed as any).type === "string") {
      this.emit((parsed as any).type, (parsed as any).data ?? {});
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
