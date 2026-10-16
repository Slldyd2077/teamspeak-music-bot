import { describe, it, expect } from "vitest";
import { WebVoiceTransmitGate } from "./web-voice-transmit.js";
import { BotInstance } from "./instance.js";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import { createRealtimeVoiceTelemetry } from "../audio/realtime-voice-telemetry.js";
import { VoiceDuckingController } from "./voice-ducking.js";
import { ManagedVoiceClientRegistry } from "./managed-voice-clients.js";
import opus from "@discordjs/opus";

describe("browser speech transmission", () => {
  it("speech ducks the receiving music bot and continuous encoded silence lets it recover", () => {
    vi.useFakeTimers();
    try {
      const receive = new EventEmitter();
      const setDuckingGain = vi.fn();
      const ducking = new VoiceDuckingController({ setDuckingGain }, { enabled: true, volumePercent: 30 });
      const registry = new ManagedVoiceClientRegistry();
      const scope = { host: 'test.invalid', voicePort: 9987 };
      registry.register(scope, 12, {}, 'web-user', 'voice-bridge');
      const music = { tsClient: receive, connected: true, managedVoiceClients: registry,
        voiceServerScope: scope, voiceDucking: ducking, registeredVoiceClientId: 20,
        webVoiceBridge: false };
      (BotInstance.prototype as any).setupTsEvents.call(music);
      const gate = new WebVoiceTransmitGate();
      const encoder = new opus.OpusEncoder(48000, 2);
      const speech = Buffer.alloc(960 * 2 * 2);
      for (let frame = 0; frame < 960; frame++) {
        const sample = Math.round(4000 * Math.sin(2 * Math.PI * 440 * frame / 48000));
        speech.writeInt16LE(sample, frame * 4);
        speech.writeInt16LE(sample, frame * 4 + 2);
      }
      const silence = Buffer.alloc(speech.length);
      const transmit = (voiced: boolean) => {
        if (gate.accept(voiced)) receive.emit('voiceActivity', {
          clientId: 12, codec: 5, clientUid: 'web-user',
          data: encoder.encode(voiced ? speech : silence),
        });
      };
      transmit(false);
      expect(ducking.isDucking()).toBe(false);
      transmit(true);
      expect(ducking.isDucking()).toBe(true);
      expect(setDuckingGain).toHaveBeenCalledWith(0.3, expect.any(Number));
      for (let i = 0; i < 70; i++) { transmit(false); vi.advanceTimersByTime(20); }
      expect(ducking.isDucking()).toBe(false);
      expect(setDuckingGain).toHaveBeenLastCalledWith(1, expect.any(Number));
      ducking.reset();
    } finally { vi.useRealTimers(); }
  });
  it("never transmits idle silence, preserves a short speech tail then releases", () => {
    const gate = new WebVoiceTransmitGate();
    expect(gate.accept(false)).toBe(false);
    expect(gate.accept(true)).toBe(true);
    for (let i = 0; i < 10; i++) expect(gate.accept(false)).toBe(true);
    expect(gate.accept(false)).toBe(false);
    gate.accept(true);
    gate.reset();
    expect(gate.accept(false)).toBe(false);
  });

  it("wires decoded browser speech to TS transmission while media stays continuous", () => {
    const player = new EventEmitter();
    const sendVoiceData = vi.fn();
    const ctx = {
      player, tsClient: { sendVoiceData }, webVoiceBridge: true,
      webVoiceTransmit: new WebVoiceTransmitGate(), liveVoiceTelemetry: createRealtimeVoiceTelemetry(),
      spotifyController: new EventEmitter(), logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    };
    (BotInstance.prototype as any).setupPlayerEvents.call(ctx);
    const frame = Buffer.from([1, 2, 3]);
    const metadata = { mode: "realtime", voiced: false, diagnostics: { bufferedMs: 0 } };
    player.emit("frame", frame, metadata);
    expect(sendVoiceData).not.toHaveBeenCalled();
    player.emit("frame", frame, { ...metadata, voiced: true });
    expect(sendVoiceData).toHaveBeenCalledOnce();
    for (let i = 0; i < 30; i++) player.emit("frame", frame, metadata);
    expect(sendVoiceData).toHaveBeenCalledTimes(11);
    expect(ctx.liveVoiceTelemetry.speechActive).toBe(false);
    player.emit("frame", frame, { ...metadata, mode: "media" });
    expect(sendVoiceData).toHaveBeenCalledTimes(12);
  });
});
