export interface RealtimeVoiceTelemetry {
  speechActive: boolean;
  consecutiveSilentFrames: number;
  speechStarts: number;
  lastFrameSentAt: number;
  lastVoicedFrameSentAt: number;
  lastSpeechStartedAt: number;
  lastStartBufferedMs: number;
}

export interface RealtimeVoiceFrameSent {
  voiced: boolean;
  bufferedMs: number;
  sentAt: number;
}

export interface RealtimeVoiceTelemetryUpdate {
  state: RealtimeVoiceTelemetry;
  speechStarted: boolean;
}

export interface RealtimePcmIngressTelemetry {
  speechActive: boolean;
  consecutiveSilentFrames: number;
  speechStarts: number;
  lastPcmAt: number;
  lastSpeechStartedAt: number;
}

export interface RealtimePcmIngressFrame {
  voiced: boolean;
  receivedAt: number;
}

export interface RealtimePcmIngressTelemetryUpdate {
  state: RealtimePcmIngressTelemetry;
  speechStarted: boolean;
}

const SPEECH_RELEASE_FRAMES = 10;

export function createRealtimePcmIngressTelemetry(): RealtimePcmIngressTelemetry {
  return {
    speechActive: false,
    consecutiveSilentFrames: 0,
    speechStarts: 0,
    lastPcmAt: 0,
    lastSpeechStartedAt: 0,
  };
}

export function updateRealtimePcmIngressTelemetry(
  current: RealtimePcmIngressTelemetry,
  frame: RealtimePcmIngressFrame,
): RealtimePcmIngressTelemetryUpdate {
  const receivedAt = Number.isFinite(frame.receivedAt) ? Math.max(0, frame.receivedAt) : 0;
  if (frame.voiced) {
    const speechStarted = !current.speechActive;
    return {
      speechStarted,
      state: {
        ...current,
        speechActive: true,
        consecutiveSilentFrames: 0,
        speechStarts: current.speechStarts + (speechStarted ? 1 : 0),
        lastPcmAt: receivedAt,
        lastSpeechStartedAt: speechStarted ? receivedAt : current.lastSpeechStartedAt,
      },
    };
  }

  const consecutiveSilentFrames = current.speechActive
    ? current.consecutiveSilentFrames + 1
    : 0;
  return {
    speechStarted: false,
    state: {
      ...current,
      speechActive: current.speechActive && consecutiveSilentFrames < SPEECH_RELEASE_FRAMES,
      consecutiveSilentFrames:
        consecutiveSilentFrames >= SPEECH_RELEASE_FRAMES ? 0 : consecutiveSilentFrames,
      lastPcmAt: receivedAt,
    },
  };
}

export function createRealtimeVoiceTelemetry(): RealtimeVoiceTelemetry {
  return {
    speechActive: false,
    consecutiveSilentFrames: 0,
    speechStarts: 0,
    lastFrameSentAt: 0,
    lastVoicedFrameSentAt: 0,
    lastSpeechStartedAt: 0,
    lastStartBufferedMs: 0,
  };
}

export function visibleRealtimeVoiceTelemetry(
  mode: "media" | "realtime",
  current: RealtimeVoiceTelemetry,
): RealtimeVoiceTelemetry {
  return mode === "realtime" ? { ...current } : createRealtimeVoiceTelemetry();
}

export function updateRealtimeVoiceTelemetry(
  current: RealtimeVoiceTelemetry,
  frame: RealtimeVoiceFrameSent,
): RealtimeVoiceTelemetryUpdate {
  const sentAt = Number.isFinite(frame.sentAt) ? Math.max(0, frame.sentAt) : 0;
  const bufferedMs = Number.isFinite(frame.bufferedMs) ? Math.max(0, frame.bufferedMs) : 0;
  if (frame.voiced) {
    const speechStarted = !current.speechActive;
    return {
      speechStarted,
      state: {
        ...current,
        speechActive: true,
        consecutiveSilentFrames: 0,
        speechStarts: current.speechStarts + (speechStarted ? 1 : 0),
        lastFrameSentAt: sentAt,
        lastVoicedFrameSentAt: sentAt,
        lastSpeechStartedAt: speechStarted ? sentAt : current.lastSpeechStartedAt,
        lastStartBufferedMs: speechStarted ? bufferedMs : current.lastStartBufferedMs,
      },
    };
  }

  const consecutiveSilentFrames = current.speechActive
    ? current.consecutiveSilentFrames + 1
    : 0;
  return {
    speechStarted: false,
    state: {
      ...current,
      speechActive: current.speechActive && consecutiveSilentFrames < SPEECH_RELEASE_FRAMES,
      consecutiveSilentFrames:
        consecutiveSilentFrames >= SPEECH_RELEASE_FRAMES ? 0 : consecutiveSilentFrames,
      lastFrameSentAt: sentAt,
    },
  };
}
