import { describe, expect, it } from "vitest";
import {
  createRealtimePcmIngressTelemetry,
  createRealtimeVoiceTelemetry,
  visibleRealtimeVoiceTelemetry,
  updateRealtimePcmIngressTelemetry,
  updateRealtimeVoiceTelemetry,
} from "./realtime-voice-telemetry.js";

describe("realtime decoded-PCM ingress telemetry", () => {
  it("timestamps the first decoded voiced frame after transport silence", () => {
    let state = createRealtimePcmIngressTelemetry();
    for (let index = 0; index < 10; index += 1) {
      state = updateRealtimePcmIngressTelemetry(state, {
        voiced: false,
        receivedAt: 1_000 + index,
      }).state;
    }

    const started = updateRealtimePcmIngressTelemetry(state, {
      voiced: true,
      receivedAt: 1_100,
    });

    expect(started.speechStarted).toBe(true);
    expect(started.state).toMatchObject({
      speechActive: true,
      speechStarts: 1,
      lastPcmAt: 1_100,
      lastSpeechStartedAt: 1_100,
    });
  });

  it("does not count continuous voiced decoder output as repeated starts", () => {
    const first = updateRealtimePcmIngressTelemetry(
      createRealtimePcmIngressTelemetry(),
      { voiced: true, receivedAt: 2_000 },
    ).state;
    const next = updateRealtimePcmIngressTelemetry(first, {
      voiced: true,
      receivedAt: 2_020,
    });

    expect(next.speechStarted).toBe(false);
    expect(next.state.speechStarts).toBe(1);
    expect(next.state.lastSpeechStartedAt).toBe(2_000);
    expect(next.state.lastPcmAt).toBe(2_020);
  });
});

describe("realtime voice TS-send telemetry", () => {
  it("does not expose a previous live session while playback is not realtime", () => {
    const stale = {
      ...createRealtimeVoiceTelemetry(),
      speechActive: true,
      speechStarts: 4,
      lastSpeechStartedAt: 12_345,
    };

    expect(visibleRealtimeVoiceTelemetry("media", stale)).toEqual(
      createRealtimeVoiceTelemetry(),
    );
    expect(visibleRealtimeVoiceTelemetry("realtime", stale)).toEqual(stale);
  });

  it("marks the first voiced frame after silence as a new speech start", () => {
    const initial = createRealtimeVoiceTelemetry();
    const result = updateRealtimeVoiceTelemetry(initial, {
      voiced: true,
      bufferedMs: 80,
      sentAt: 1234,
    });

    expect(result.speechStarted).toBe(true);
    expect(result.state).toMatchObject({
      speechActive: true,
      speechStarts: 1,
      lastSpeechStartedAt: 1234,
      lastVoicedFrameSentAt: 1234,
      lastStartBufferedMs: 80,
    });
    expect(initial.speechStarts).toBe(0);
  });

  it("does not split a sentence on short internal pauses", () => {
    let state = updateRealtimeVoiceTelemetry(createRealtimeVoiceTelemetry(), {
      voiced: true,
      bufferedMs: 60,
      sentAt: 1000,
    }).state;

    for (let index = 0; index < 9; index += 1) {
      state = updateRealtimeVoiceTelemetry(state, {
        voiced: false,
        bufferedMs: 40,
        sentAt: 1020 + index * 20,
      }).state;
    }
    const resumed = updateRealtimeVoiceTelemetry(state, {
      voiced: true,
      bufferedMs: 40,
      sentAt: 1220,
    });

    expect(resumed.speechStarted).toBe(false);
    expect(resumed.state.speechStarts).toBe(1);
  });

  it("starts a new utterance after 200ms of sent silence", () => {
    let state = updateRealtimeVoiceTelemetry(createRealtimeVoiceTelemetry(), {
      voiced: true,
      bufferedMs: 20,
      sentAt: 1000,
    }).state;

    for (let index = 0; index < 10; index += 1) {
      state = updateRealtimeVoiceTelemetry(state, {
        voiced: false,
        bufferedMs: 20,
        sentAt: 1020 + index * 20,
      }).state;
    }
    const next = updateRealtimeVoiceTelemetry(state, {
      voiced: true,
      bufferedMs: 20,
      sentAt: 1240,
    });

    expect(next.speechStarted).toBe(true);
    expect(next.state.speechStarts).toBe(2);
  });
});
