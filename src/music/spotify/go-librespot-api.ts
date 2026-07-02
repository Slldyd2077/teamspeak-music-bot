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

export class GoLibrespotEventClient extends EventEmitter {
  private wsUrl: string;
  private WebSocketCtor: WebSocketCtor;
  private ws: WsLike | null = null;
  private stopped = false;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    ws.on("open", () => {
      this.reconnectDelay = INITIAL_RECONNECT_MS;
    });
    ws.on("message", (buf: unknown) => this.handleMessage(buf));
    ws.on("close", () => {
      this.ws = null;
      this.scheduleReconnect();
    });
    ws.on("error", (err: unknown) => {
      if (this.listenerCount("error") > 0) this.emit("error", err);
    });
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
