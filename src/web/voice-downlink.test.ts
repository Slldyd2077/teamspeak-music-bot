import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  encodeVoicePacket,
  opusPacketDurationSamples,
  setupVoiceDownlink,
  VOICE_PACKET_HEADER_BYTES,
} from "./voice-downlink.js";

vi.mock("ws", () => ({
  WebSocket: { OPEN: 1 },
}));

describe("voice downlink packet format", () => {
  it("computes Opus duration from the TOC instead of hard-coding 20 ms", () => {
    expect(opusPacketDurationSamples(Uint8Array.of(0b1000_0000))).toBe(120);
    expect(opusPacketDurationSamples(Uint8Array.of(0b1001_1000))).toBe(960);
    expect(opusPacketDurationSamples(Uint8Array.of(0b0000_1000))).toBe(960);
    expect(opusPacketDurationSamples(Uint8Array.of(0b0001_1000))).toBe(2880);
    expect(opusPacketDurationSamples(Uint8Array.of(0b1000_0011, 2))).toBe(240);
    expect(opusPacketDurationSamples(Uint8Array.of(0b1001_1011, 7))).toBe(960);
    expect(opusPacketDurationSamples(new Uint8Array())).toBe(960);
  });

  it("encodes speaker, codec, duration and raw Opus bytes", () => {
    const packet = encodeVoicePacket({ clientId: 513, codec: 4, data: Buffer.from([0x08, 0xaa]) });
    expect(packet[0]).toBe(1);
    expect(packet[1]).toBe(4);
    expect(packet.readUInt16BE(2)).toBe(513);
    expect(packet.readUInt16BE(4)).toBe(960);
    expect([...packet.subarray(VOICE_PACKET_HEADER_BYTES)]).toEqual([0x08, 0xaa]);
  });
});

/** Bot double that records the `<WEB通讯>` marker toggles it receives. */
function fakeBot() {
  const bot = new EventEmitter() as EventEmitter & {
    webVoiceCalls: boolean[];
    setWebVoiceActive(active: boolean): Promise<void>;
  };
  bot.webVoiceCalls = [];
  bot.setWebVoiceActive = async (active: boolean) => {
    bot.webVoiceCalls.push(active);
  };
  return bot;
}

function fakeSocket(botId: string, sent: Buffer[]) {
  const ws = new EventEmitter() as any;
  ws.voiceBotId = botId;
  ws.readyState = 1;
  ws.closeCalls = [] as Array<{ code?: number; reason?: string }>;
  ws.send = (data: Buffer) => sent.push(data);
  ws.close = (code?: number, reason?: string) => {
    ws.closeCalls.push({ code, reason });
  };
  return ws;
}

describe("voice downlink fanout", () => {
  it("forwards Opus codecs and detaches on close", () => {
    const bot = fakeBot();
    const sent: Buffer[] = [];
    const ws = fakeSocket("bot-a", sent);
    const wss = new EventEmitter() as any;
    const controller = setupVoiceDownlink(
      wss,
      { getBot: (id: string) => (id === "bot-a" ? bot : undefined) } as any,
      { debug() {}, warn() {} } as any,
    );

    wss.emit("connection", ws);
    bot.emit("voiceFrame", { clientId: 7, codec: 4, data: Buffer.from([0x08]) });
    bot.emit("voiceFrame", { clientId: 8, codec: 2, data: Buffer.from([0x08]) });
    expect(sent).toHaveLength(1);

    ws.emit("close");
    bot.emit("voiceFrame", { clientId: 7, codec: 4, data: Buffer.from([0x08]) });
    expect(sent).toHaveLength(1);
    controller.cleanup();
  });

  it("shows the web voice marker only while someone is actually listening", () => {
    const bot = fakeBot();
    const sent: Buffer[] = [];
    const wss = new EventEmitter() as any;
    setupVoiceDownlink(
      wss,
      { getBot: () => bot } as any,
      { debug() {}, warn() {} } as any,
    );

    const first = fakeSocket("bot-a", sent);
    const second = fakeSocket("bot-a", sent);
    wss.emit("connection", first);
    expect(bot.webVoiceCalls).toEqual([true]);

    // A second listener must not re-announce, and the first one leaving must
    // not clear the marker while the second is still connected.
    wss.emit("connection", second);
    expect(bot.webVoiceCalls).toEqual([true]);
    first.emit("close");
    expect(bot.webVoiceCalls).toEqual([true]);

    second.emit("close");
    expect(bot.webVoiceCalls).toEqual([true, false]);
  });

  it("counts a socket down once even when close and error both fire", () => {
    const bot = fakeBot();
    const sent: Buffer[] = [];
    const wss = new EventEmitter() as any;
    setupVoiceDownlink(
      wss,
      { getBot: () => bot } as any,
      { debug() {}, warn() {} } as any,
    );

    const only = fakeSocket("bot-a", sent);
    const other = fakeSocket("bot-a", sent);
    wss.emit("connection", only);
    wss.emit("connection", other);
    only.emit("error", new Error("reset"));
    only.emit("close");
    // Double-counting here would drop the count to 0 and wrongly clear the
    // marker while `other` is still listening.
    expect(bot.webVoiceCalls).toEqual([true]);

    other.emit("close");
    expect(bot.webVoiceCalls).toEqual([true, false]);
  });

  it("actively closes and detaches when the bot TS connection drops", () => {
    const bot = fakeBot();
    const sent: Buffer[] = [];
    const ws = fakeSocket("bot-a", sent);
    const wss = new EventEmitter() as any;
    setupVoiceDownlink(
      wss,
      { getBot: (id: string) => (id === "bot-a" ? bot : undefined) } as any,
      { debug() {}, warn() {} } as any,
    );

    wss.emit("connection", ws);
    expect(bot.listenerCount("voiceFrame")).toBe(1);
    expect(bot.listenerCount("disconnected")).toBe(1);

    bot.emit("disconnected");

    expect(ws.closeCalls).toHaveLength(1);
    expect(ws.closeCalls[0].reason).toMatch(/disconnect/i);
    expect(bot.listenerCount("voiceFrame")).toBe(0);
    expect(bot.listenerCount("disconnected")).toBe(0);
    expect(bot.webVoiceCalls).toEqual([true, false]);

    ws.emit("close");
    bot.emit("voiceFrame", { clientId: 7, codec: 4, data: Buffer.from([0x08]) });
    expect(sent).toHaveLength(0);
    expect(ws.closeCalls).toHaveLength(1);
    expect(bot.webVoiceCalls).toEqual([true, false]);
  });

  it("keeps a healthy downlink open and forwards voice frames", () => {
    const bot = fakeBot();
    const sent: Buffer[] = [];
    const ws = fakeSocket("bot-a", sent);
    const wss = new EventEmitter() as any;
    setupVoiceDownlink(
      wss,
      { getBot: (id: string) => (id === "bot-a" ? bot : undefined) } as any,
      { debug() {}, warn() {} } as any,
    );

    wss.emit("connection", ws);
    bot.emit("voiceFrame", { clientId: 9, codec: 5, data: Buffer.from([0x08, 0xaa]) });

    expect(ws.closeCalls).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe(1);
    expect(sent[0][1]).toBe(5);
    expect(sent[0].readUInt16BE(2)).toBe(9);
  });

  it("closes every listener exactly once when their shared bot disconnects", () => {
    const bot = fakeBot();
    const sent: Buffer[] = [];
    const first = fakeSocket("bot-a", sent);
    const second = fakeSocket("bot-a", sent);
    const wss = new EventEmitter() as any;
    setupVoiceDownlink(
      wss,
      { getBot: (id: string) => (id === "bot-a" ? bot : undefined) } as any,
      { debug() {}, warn() {} } as any,
    );

    wss.emit("connection", first);
    wss.emit("connection", second);
    expect(bot.listenerCount("disconnected")).toBe(2);

    bot.emit("disconnected");

    expect(first.closeCalls).toHaveLength(1);
    expect(second.closeCalls).toHaveLength(1);
    expect(bot.listenerCount("voiceFrame")).toBe(0);
    expect(bot.listenerCount("disconnected")).toBe(0);
    expect(bot.webVoiceCalls).toEqual([true, false]);
  });
});
