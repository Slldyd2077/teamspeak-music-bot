import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { WebSocketServer, WebSocket as WSClient } from "ws";
import { AddressInfo } from "node:net";
import { createDatabase, type BotDatabase } from "../data/database.js";
import { createUserStore } from "../data/users.js";
import { createSessionStore } from "../data/sessions.js";
import { validateSessionFromHeaders, SESSION_COOKIE_NAME } from "./auth/validateSession.js";
import { setupWebSocket } from "./websocket.js";

function buildServer(sessions: ReturnType<typeof createSessionStore>) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => ws.send("hello"));
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") return socket.destroy();
    const r = validateSessionFromHeaders(req.headers.cookie as string | undefined, sessions);
    if (!r) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  return { server, wss };
}

describe("WebSocket auth at upgrade", () => {
  let botDb: BotDatabase;
  let httpServer: http.Server;
  let port: number;
  let validToken: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const u = await users.createUser("alice", "pw-alice", "admin");
    validToken = sessions.createSession(u.id).token;

    const { server } = buildServer(sessions);
    httpServer = server;
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    botDb.close();
  });

  it("rejects upgrade without cookie (server-side close before open)", async () => {
    const ws = new WSClient(`ws://127.0.0.1:${port}/ws`);
    const result = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("opened"));
      ws.on("unexpected-response", (_req, res) => resolve(`status:${res.statusCode}`));
      ws.on("error", () => resolve("error"));
    });
    expect(result).toMatch(/^status:401$|^error$/);
  });

  it("accepts upgrade with a valid cookie", async () => {
    const ws = new WSClient(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${validToken}` },
    });
    const msg = await new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
    });
    expect(msg).toBe("hello");
    ws.close();
  });
});

describe("WebSocket guest bot scope", () => {
  it("guest init is filtered to the guest bot scope", () => {
    const sent: any[] = [];
    const fakeWs: any = {
      readyState: 1,
      isGuest: true,
      botScope: new Set(["bot1"]),
      send: (m: string) => sent.push(JSON.parse(m)),
      on: () => {},
    };
    const fakeWss: any = {
      on: (ev: string, cb: any) => {
        if (ev === "connection") fakeWss._conn = cb;
      },
    };
    const makeBot = (id: string) => ({
      id,
      getStatus: () => ({ id }),
      getQueue: () => [],
      on: () => {},
      removeListener: () => {},
    });
    const botManager: any = {
      getAllBots: () => [makeBot("bot1"), makeBot("bot2")],
      on: () => {},
      off: () => {},
      removeListener: () => {},
    };
    const { cleanup } = setupWebSocket(fakeWss, botManager, {
      debug() {},
      error() {},
      info() {},
      warn() {},
    } as any);
    fakeWss._conn(fakeWs);
    const init = sent.find((m) => m.type === "init");
    expect(init.bots.map((b: any) => b.id)).toEqual(["bot1"]);
    cleanup();
  });
});

describe("WebSocket refreshGuestPolicy", () => {
  function makeHarness() {
    const clients: any[] = [];
    const fakeWss: any = {
      on: (ev: string, cb: any) => {
        if (ev === "connection") fakeWss._conn = cb;
      },
    };
    const botManager: any = {
      getAllBots: () => [],
      on: () => {},
      off: () => {},
      removeListener: () => {},
    };
    const logger = { debug() {}, error() {}, info() {}, warn() {} } as any;
    const controller = setupWebSocket(fakeWss, botManager, logger);
    // Connect fake sockets via the connection handler so they land in `clients`.
    const connect = (ws: any) => {
      clients.push(ws);
      fakeWss._conn(ws);
    };
    return { controller, connect };
  }

  function makeFakeWs(opts: { isGuest: boolean; botScope?: "all" | Set<string> }) {
    const closeCalls: Array<{ code?: number; reason?: string }> = [];
    const ws: any = {
      readyState: 1,
      isGuest: opts.isGuest,
      botScope: opts.botScope,
      send: () => {},
      on: () => {},
      close: (code?: number, reason?: string) => closeCalls.push({ code, reason }),
    };
    return { ws, closeCalls };
  }

  it("disabling guest mode closes guest sockets but leaves non-guest sockets open", () => {
    const { controller, connect } = makeHarness();
    const guest = makeFakeWs({ isGuest: true, botScope: new Set(["bot1"]) });
    const member = makeFakeWs({ isGuest: false, botScope: "all" });
    connect(guest.ws);
    connect(member.ws);

    controller.refreshGuestPolicy({ enabled: false, bots: "all" });

    expect(guest.closeCalls.length).toBe(1);
    expect(guest.closeCalls[0].code).toBe(1008);
    expect(member.closeCalls.length).toBe(0);
  });

  it("narrowing the guest scope live re-scopes open guest sockets", () => {
    const { controller, connect } = makeHarness();
    const guest = makeFakeWs({ isGuest: true, botScope: new Set(["bot1"]) });
    connect(guest.ws);

    controller.refreshGuestPolicy({ enabled: true, bots: ["bot2"] });

    expect(guest.closeCalls.length).toBe(0);
    expect(guest.ws.botScope instanceof Set).toBe(true);
    expect(guest.ws.botScope.has("bot2")).toBe(true);
    expect(guest.ws.botScope.has("bot1")).toBe(false);
  });
});
