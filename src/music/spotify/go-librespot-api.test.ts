import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { AxiosInstance } from "axios";
import { GoLibrespotRestClient, GoLibrespotEventClient } from "./go-librespot-api.js";

/** Minimal axios stub: only get/post are exercised by the client. */
function makeHttp(overrides?: Partial<Record<"get" | "post", any>>) {
  return {
    get: vi.fn().mockResolvedValue({ status: 200, data: {} }),
    post: vi.fn().mockResolvedValue({ status: 200, data: {} }),
    ...overrides,
  } as unknown as AxiosInstance;
}

describe("GoLibrespotRestClient", () => {
  it("ping() returns true on GET / -> 200", async () => {
    const http = makeHttp();
    const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
    await expect(client.ping()).resolves.toBe(true);
    expect(http.get).toHaveBeenCalledWith("/");
  });

  it("ping() returns false when GET / rejects (daemon not up)", async () => {
    const http = makeHttp({ get: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) });
    const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
    await expect(client.ping()).resolves.toBe(false);
  });

  it("playTrack() POSTs /player/play with the uri body", async () => {
    const http = makeHttp();
    const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
    await client.playTrack("spotify:track:abc123");
    expect(http.post).toHaveBeenCalledWith("/player/play", { uri: "spotify:track:abc123" });
  });

  it("pause/resume/stop POST their bodyless endpoints", async () => {
    const http = makeHttp();
    const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
    await client.pause();
    await client.resume();
    await client.stop();
    expect(http.post).toHaveBeenNthCalledWith(1, "/player/pause");
    expect(http.post).toHaveBeenNthCalledWith(2, "/player/resume");
    expect(http.post).toHaveBeenNthCalledWith(3, "/player/stop");
  });

  it("seek() POSTs /player/seek with position(ms) and relative:false", async () => {
    const http = makeHttp();
    const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
    await client.seek(42000);
    expect(http.post).toHaveBeenCalledWith("/player/seek", { position: 42000, relative: false });
  });

  it("playTrack() rejects when the POST fails (surfaced to caller)", async () => {
    const http = makeHttp({ post: vi.fn().mockRejectedValue(new Error("boom")) });
    const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
    await expect(client.playTrack("spotify:track:x")).rejects.toThrow("boom");
  });

  it("getStatus() normalizes the /status shape (ms position/duration)", async () => {
    const http = makeHttp({
      get: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          stopped: false,
          paused: false,
          buffering: false,
          track: {
            uri: "spotify:track:abc",
            name: "Song",
            artist_names: ["A", "B"],
            album_name: "Alb",
            album_cover_url: "https://i.scdn.co/c.jpg",
            position: 12345,
            duration: 200000,
          },
        },
      }),
    });
    const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
    const status = await client.getStatus();
    expect(http.get).toHaveBeenCalledWith("/status");
    expect(status).toEqual({
      stopped: false,
      paused: false,
      buffering: false,
      track: {
        uri: "spotify:track:abc",
        name: "Song",
        artist_names: ["A", "B"],
        album_name: "Alb",
        album_cover_url: "https://i.scdn.co/c.jpg",
        position: 12345,
        duration: 200000,
      },
    });
  });

  it("getStatus() returns null with a null track when nothing is loaded", async () => {
    const http = makeHttp({ get: vi.fn().mockResolvedValue({ status: 200, data: { stopped: true, paused: false, buffering: false, track: null } }) });
    const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
    const status = await client.getStatus();
    expect(status).toEqual({ stopped: true, paused: false, buffering: false, track: null });
  });

  it("getStatus() returns null when GET /status rejects", async () => {
    const http = makeHttp({ get: vi.fn().mockRejectedValue(new Error("down")) });
    const client = new GoLibrespotRestClient("http://127.0.0.1:3678", { http });
    await expect(client.getStatus()).resolves.toBeNull();
  });
});

/** Fake ws: records instances, lets tests drive open/message/close/error. */
class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  closed = false;
  constructor(public url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
    this.emit("close");
  }
}

function frame(type: string, data: unknown): Buffer {
  return Buffer.from(JSON.stringify({ type, data }));
}

describe("GoLibrespotEventClient", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it("emits 'not_playing' (track-end) with its data payload", () => {
    const client = new GoLibrespotEventClient("ws://127.0.0.1:3678/events", {
      WebSocketCtor: FakeWebSocket as any,
    });
    const onEnded = vi.fn();
    client.on("not_playing", onEnded);
    client.start();

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("ws://127.0.0.1:3678/events");
    ws.emit("message", frame("not_playing", { uri: "spotify:track:abc", play_origin: "go-librespot" }));

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith({ uri: "spotify:track:abc", play_origin: "go-librespot" });
    client.stop();
  });

  it("emits 'metadata' with the now-playing object", () => {
    const client = new GoLibrespotEventClient("ws://127.0.0.1:3678/events", {
      WebSocketCtor: FakeWebSocket as any,
    });
    const onMeta = vi.fn();
    client.on("metadata", onMeta);
    client.start();

    FakeWebSocket.instances[0].emit(
      "message",
      frame("metadata", { uri: "spotify:track:xyz", name: "Song", artist_names: ["Q"], duration: 200000 }),
    );

    expect(onMeta).toHaveBeenCalledWith({ uri: "spotify:track:xyz", name: "Song", artist_names: ["Q"], duration: 200000 });
    client.stop();
  });

  it("ignores non-JSON frames without throwing", () => {
    const client = new GoLibrespotEventClient("ws://x/events", { WebSocketCtor: FakeWebSocket as any });
    const onAny = vi.fn();
    client.on("metadata", onAny);
    client.start();
    expect(() => FakeWebSocket.instances[0].emit("message", Buffer.from("not json"))).not.toThrow();
    expect(onAny).not.toHaveBeenCalled();
    client.stop();
  });

  it("reconnects with backoff after the socket closes", () => {
    vi.useFakeTimers();
    try {
      const client = new GoLibrespotEventClient("ws://x/events", { WebSocketCtor: FakeWebSocket as any });
      client.start();
      expect(FakeWebSocket.instances).toHaveLength(1);

      FakeWebSocket.instances[0].emit("close");
      expect(FakeWebSocket.instances).toHaveLength(1); // not immediate
      vi.advanceTimersByTime(500);
      expect(FakeWebSocket.instances).toHaveLength(2); // reconnected
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() closes the socket and prevents reconnect", () => {
    vi.useFakeTimers();
    try {
      const client = new GoLibrespotEventClient("ws://x/events", { WebSocketCtor: FakeWebSocket as any });
      client.start();
      const ws = FakeWebSocket.instances[0];
      client.stop();
      expect(ws.closed).toBe(true);
      vi.advanceTimersByTime(60000);
      expect(FakeWebSocket.instances).toHaveLength(1); // no new socket
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not throw on socket 'error' when no error listener is attached", () => {
    const client = new GoLibrespotEventClient("ws://x/events", { WebSocketCtor: FakeWebSocket as any });
    client.start();
    expect(() => FakeWebSocket.instances[0].emit("error", new Error("net"))).not.toThrow();
    client.stop();
  });
});
