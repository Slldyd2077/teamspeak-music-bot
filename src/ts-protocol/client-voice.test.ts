import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client as SDKClient, type ResolvedAddr } from "@honeybbq/teamspeak-client";
import { Resolver } from "@honeybbq/teamspeak-client/discovery";
import { TS3Client, type TS3VoiceSendFailure } from "./client.js";
import type { TrackingVoiceEndpointResolver } from "./voice-endpoint.js";
import type { Logger } from "../logger.js";

type Failure = TS3VoiceSendFailure;
type Harness = { client: SDKClient | null; voiceFramesSent: number };

describe("TS3Client voice send failure lifecycle", () => {
  let client: TS3Client;
  let sdk: SDKClient;
  let logger: Logger;
  let records: Array<{ level: string; args: unknown[] }>;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Keep the real SDK object, logger bridge and event dispatch. Replace only
    // its network handshake and explicit shutdown so no UDP socket is opened.
    vi.spyOn(SDKClient.prototype, "connect").mockImplementation(async function (this: SDKClient) {
      this.clid = 42;
      this._markConnected();
    });
    vi.spyOn(SDKClient.prototype, "disconnect").mockImplementation(async function (this: SDKClient) {
      this.handler.onClosed?.(null);
    });
    records = [];
    const capture = (level: string) => (...args: unknown[]) => records.push({ level, args });
    logger = { info: capture("info"), warn: capture("warn"), error: capture("error"), debug() {} } as unknown as Logger;
    client = new TS3Client({ host: "localhost", port: 9987, queryPort: 10011, nickname: "VoiceTest", serverProtocol: "ts3" }, logger);
    await client.connect();
    sdk = (client as unknown as Harness).client!;
  });

  afterEach(async () => {
    client.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([false, true])("reports a sanitized first failure after earlier accepted send=%s without throwing", (acceptedFirst) => {
    const send = vi.spyOn(sdk, "sendVoice").mockImplementation(() => {});
    if (acceptedFirst) client.sendVoiceData(Buffer.from([1]));
    const failures: Failure[] = [];
    client.on("voiceSendFailure", event => failures.push(event));
    send.mockImplementation(() => { throw Object.assign(new Error("https://user:password@host/?token=credential-secret"), { code: "ERR_SOCKET_DGRAM_NOT_RUNNING", spawnargs: ["credential-secret"] }); });

    let result: unknown;
    expect(() => { result = client.sendVoiceData(Buffer.from([2])); }).not.toThrow();
    expect(result).toBe("retrying");
    expect(failures).toEqual([{ code: "ERR_SOCKET_DGRAM_NOT_RUNNING", consecutiveFailures: 1, durationMs: 0 }]);
    expect((client as unknown as Harness).voiceFramesSent).toBe(acceptedFirst ? 1 : 0);
    expect(records.filter(record => record.level === "warn")).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("password");
    expect(JSON.stringify(records)).not.toContain("credential-secret");
  });

  it.each([{ code: "credential-secret", message: "credential-secret" }, "credential-secret"])("omits untrusted error codes and primitive error text: %s", error => {
    const failures: Failure[] = [];
    client.on("voiceSendFailure", event => failures.push(event));
    vi.spyOn(sdk, "sendVoice").mockImplementation(() => { throw error; });
    client.sendVoiceData(Buffer.from([1]));
    expect(failures).toEqual([{ consecutiveFailures: 1, durationMs: 0 }]);
    expect(JSON.stringify(records)).not.toContain("credential-secret");
  });

  it("emits one recovery and cancels terminal failure when the next send succeeds", async () => {
    const recovered: Failure[] = [];
    const terminal: Failure[] = [];
    client.on("voiceSendRecovered", event => recovered.push(event));
    client.on("voiceSendFailed", event => terminal.push(event));
    const send = vi.spyOn(sdk, "sendVoice").mockImplementation(() => { throw { code: "ENOBUFS" }; });
    client.sendVoiceData(Buffer.from([1]));
    await vi.advanceTimersByTimeAsync(20);
    send.mockImplementation(() => {});
    expect(client.sendVoiceData(Buffer.from([2]))).toBe("accepted");
    client.sendVoiceData(Buffer.from([3]));
    await vi.advanceTimersByTimeAsync(3000);
    expect(recovered).toEqual([{ code: "ENOBUFS", consecutiveFailures: 1, durationMs: 20 }]);
    expect(terminal).toEqual([]);
    expect((client as unknown as Harness).voiceFramesSent).toBe(2);
  });

  it("bounds persistent failure reporting to one first event and one terminal event per burst", async () => {
    const first: Failure[] = [];
    const terminal: Failure[] = [];
    client.on("voiceSendFailure", event => first.push(event));
    client.on("voiceSendFailed", event => terminal.push(event));
    vi.spyOn(sdk, "sendVoice").mockImplementation(() => { throw { code: "ERR_SOCKET_DGRAM_NOT_RUNNING" }; });
    for (let i = 0; i < 100; i++) {
      client.sendVoiceData(Buffer.from([1]));
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(first).toHaveLength(1);
    expect(terminal).toEqual([{ code: "ERR_SOCKET_DGRAM_NOT_RUNNING", consecutiveFailures: 100, durationMs: 2000 }]);
    for (let i = 0; i < 100; i++) expect(client.sendVoiceData(Buffer.from([1]))).toBe("failed");
    await vi.advanceTimersByTimeAsync(10000);
    expect(terminal).toHaveLength(1);
    expect(records.filter(record => ["warn", "error"].includes(record.level)).length).toBeLessThanOrEqual(2);
    expect((client as unknown as Harness).voiceFramesSent).toBe(0);
  });

  it("recovers after the terminal event and allows a fresh failure burst", async () => {
    const first: Failure[] = [], recovered: Failure[] = [], terminal: Failure[] = [];
    client.on("voiceSendFailure", event => first.push(event));
    client.on("voiceSendRecovered", event => recovered.push(event));
    client.on("voiceSendFailed", event => terminal.push(event));
    const send = vi.spyOn(sdk, "sendVoice").mockImplementation(() => { throw { code: "EPIPE" }; });
    client.sendVoiceData(Buffer.from([1]));
    await vi.advanceTimersByTimeAsync(2000);
    send.mockImplementation(() => {});
    expect(client.sendVoiceData(Buffer.from([1]))).toBe("accepted");
    send.mockImplementation(() => { throw { code: "EPIPE" }; });
    client.sendVoiceData(Buffer.from([1]));
    await vi.advanceTimersByTimeAsync(2000);
    expect(first).toHaveLength(2);
    expect(recovered).toHaveLength(1);
    expect(terminal).toHaveLength(2);
  });

  it("cancels failure timers on explicit disconnect", async () => {
    const terminal: Failure[] = [];
    client.on("voiceSendFailed", event => terminal.push(event));
    const send = vi.spyOn(sdk, "sendVoice").mockImplementation(() => {});
    client.sendVoiceData(Buffer.from([1]));
    send.mockImplementation(() => { throw { code: "EPIPE" }; });
    client.sendVoiceData(Buffer.from([1]));
    client.disconnect();
    expect(client.sendVoiceData(Buffer.from([1]))).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(3000);
    expect(terminal).toEqual([]);
    expect((client as unknown as Harness).voiceFramesSent).toBe(0);
  });

  it("cancels failure timers on SDK connection loss", async () => {
    const terminal: Failure[] = [];
    client.on("voiceSendFailed", event => terminal.push(event));
    const send = vi.spyOn(sdk, "sendVoice").mockImplementation(() => {});
    client.sendVoiceData(Buffer.from([1]));
    send.mockImplementation(() => { throw { code: "EPIPE" }; });
    client.sendVoiceData(Buffer.from([1]));
    sdk.handler.onClosed?.(new Error("synthetic connection loss"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(terminal).toEqual([]);
    expect((client as unknown as Harness).voiceFramesSent).toBe(0);
    send.mockClear();
    client.sendVoiceData(Buffer.from([1]));
    expect(send).not.toHaveBeenCalled();
  });

  it("does not revive a connection whose handshake was cancelled", async () => {
    let finishHandshake!: () => void;
    vi.spyOn(SDKClient.prototype, "connect").mockImplementationOnce(function (this: SDKClient) {
      return new Promise<void>(resolve => {
        finishHandshake = () => {
          this.clid = 99;
          this._markConnected();
          resolve();
        };
      });
    });
    const connected = vi.fn();
    client.on("connected", connected);
    const pending = client.connect();
    await Promise.resolve();
    expect(finishHandshake).toBeTypeOf("function");
    const connectingSdk = (client as unknown as Harness).client!;
    const close = vi.spyOn(connectingSdk.handler, "close");
    const send = vi.spyOn(connectingSdk, "sendVoice");
    client.disconnect();
    finishHandshake();
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getClientId()).toBe(0);
    expect(connected).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    client.sendVoiceData(Buffer.from([1]));
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores old SDK warnings and disconnect callbacks after replacement", async () => {
    const terminal: Failure[] = [];
    client.on("voiceSendFailed", event => terminal.push(event));
    vi.spyOn(sdk, "sendVoice").mockImplementation(() => { throw { code: "EPIPE" }; });
    client.sendVoiceData(Buffer.from([1]));
    await client.connect();
    // Old disconnect dispatch is queued; old socket callbacks may follow it.
    const before = records.length;
    sdk.logger.warn("udp send error", Object.assign(new Error("credential-secret"), { code: "ECONNREFUSED" }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.getClientId()).toBe(42);
    expect(records.slice(before).filter(record => record.level === "warn")).toEqual([]);
    expect(terminal).toEqual([]);
  });

  it("does not let an older named-channel lookup move the replacement connection", async () => {
    client.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    client = new TS3Client({ host: "localhost", port: 9987, queryPort: 10011, nickname: "VoiceTest", serverProtocol: "ts3", defaultChannel: "Music" }, logger);
    let nextClientId = 101;
    vi.mocked(SDKClient.prototype.connect).mockImplementation(async function (this: SDKClient) {
      this.clid = nextClientId++;
      this._markConnected();
    });
    let finishOlderLookup!: (rows: Record<string, string>[]) => void;
    vi.spyOn(SDKClient.prototype, "execCommandWithResponse").mockImplementation(function (this: SDKClient) {
      if (this.clid === 101) return new Promise(resolve => { finishOlderLookup = resolve; });
      return Promise.resolve([{ cid: "20", channel_name: "Music" }]);
    });
    const moves: Array<{ clientId: number; command: string }> = [];
    vi.spyOn(SDKClient.prototype, "execCommand").mockImplementation(async function (this: SDKClient, command: string) {
      moves.push({ clientId: this.clid, command });
    });
    const first = client.connect();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(finishOlderLookup).toBeTypeOf("function");
    await client.connect();
    finishOlderLookup([{ cid: "10", channel_name: "Music" }]);
    await first;
    expect(moves).toEqual([{ clientId: 102, command: "clientmove clid=102 cid=20" }]);
    expect(records.filter(record => record.args[1] === "Joined channel").map(record => record.args[0])).toEqual([{ channelName: "Music", cid: "20" }]);
    expect(client.getClientId()).toBe(102);
  });

  it("keeps the replacement endpoint when an older DNS resolution finishes last", async () => {
    let finishOlderResolution!: (rows: ResolvedAddr[]) => void;
    const row = (addr: string): ResolvedAddr => ({ addr, source: "test", expiry: new Date(0) });
    vi.spyOn(Resolver.prototype, "resolve").mockImplementationOnce(() => new Promise(resolve => { finishOlderResolution = resolve; }))
      .mockResolvedValue([row("192.0.2.2:9987")]);
    let sequence = 0;
    vi.mocked(SDKClient.prototype.connect).mockImplementation(async function (this: SDKClient) {
      const clientId = 101 + sequence++;
      const resolver = (client as unknown as { voiceEndpointResolver: TrackingVoiceEndpointResolver }).voiceEndpointResolver;
      await resolver.resolve("voice.test:9987");
      this.clid = clientId;
      this._markConnected();
    });
    const first = client.connect();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(finishOlderResolution).toBeTypeOf("function");
    await client.connect();
    expect(client.getResolvedVoiceEndpoint()).toEqual({ host: "192.0.2.2", port: 9987 });
    finishOlderResolution([row("192.0.2.1:9987")]);
    await first;
    expect(client.getClientId()).toBe(102);
    expect(client.getResolvedVoiceEndpoint()).toEqual({ host: "192.0.2.2", port: 9987 });
  });

  it.each(["10", "Music"])("does not report an old %s channel move after connection replacement", async channel => {
    vi.spyOn(SDKClient.prototype, "execCommandWithResponse").mockResolvedValue([{ cid: "10", channel_name: "Music" }]);
    let finishMove!: () => void;
    const move = vi.spyOn(sdk, "execCommand").mockImplementation(() => new Promise<void>(resolve => { finishMove = resolve; }));
    const joining = client.joinChannel(channel);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(move).toHaveBeenCalledWith("clientmove clid=42 cid=10", 10000);
    await client.connect();
    finishMove();
    await joining;
    expect(records.filter(record => record.args[1] === "Joined channel")).toEqual([]);
  });

  it("does not report a stale channel lookup failure against the new connection", async () => {
    let failLookup!: (error: Error) => void;
    vi.spyOn(sdk, "execCommandWithResponse").mockImplementation(() => new Promise((_resolve, reject) => { failLookup = reject; }));
    const joining = client.joinChannel("Music");
    await client.connect();
    failLookup(new Error("old credential-secret failure"));
    await joining;
    expect(records.filter(record => record.level === "error")).toEqual([]);
    expect(JSON.stringify(records)).not.toContain("credential-secret");
  });

  it("keeps safe async UDP error detail while throttling without terminalizing it", async () => {
    const terminal: Failure[] = [];
    client.on("voiceSendFailed", event => terminal.push(event));
    for (let i = 0; i < 100; i++) sdk.logger.warn("udp send error", Object.assign(new Error("credential-secret"), { code: "ECONNREFUSED" }));
    await vi.advanceTimersByTimeAsync(2000);
    const warnings = records.filter(record => record.level === "warn");
    expect(warnings).toHaveLength(2);
    expect(warnings[0].args[0]).toMatchObject({ code: "ECONNREFUSED", count: 1 });
    expect(warnings[1].args[0]).toMatchObject({ code: "ECONNREFUSED", count: 100 });
    expect(JSON.stringify(records)).not.toContain("credential-secret");
    expect(terminal).toEqual([]);
  });

  it("discards unsafe async UDP codes and cancels their summary on disconnect", async () => {
    sdk.logger.warn("udp send error", { code: "credential-secret", message: "credential-secret" });
    client.disconnect();
    await vi.advanceTimersByTimeAsync(3000);
    expect(records.filter(record => record.level === "warn").filter(record => String(record.args[1]).includes("udp send error"))).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("credential-secret");
  });
});
