import { WebSocket, type WebSocketServer } from "ws";
import type { BotManager } from "../bot/manager.js";
import { type BotInstance } from "../bot/instance.js";
import type { TS3VoiceFrame } from "../ts-protocol/client.js";
import type { Logger } from "../logger.js";

export const VOICE_PACKET_VERSION = 1;
export const VOICE_PACKET_HEADER_BYTES = 6;

/**
 * Return the decoded duration of an RFC 6716 Opus packet at 48 kHz.
 * TeamSpeak normally sends 20 ms packets, but Opus permits other durations.
 */
export function opusPacketDurationSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 960;
  const config = packet[0]! >> 3;
  let samplesPerFrame: number;
  if (config >= 16) {
    samplesPerFrame = 120 << (config & 0x03); // 2.5, 5, 10, 20 ms
  } else if (config >= 12) {
    samplesPerFrame = 480 << (config & 0x01); // 10 or 20 ms
  } else {
    samplesPerFrame = [480, 960, 1920, 2880][config & 0x03]!; // 10, 20, 40, 60 ms
  }

  const countCode = packet[0]! & 0x03;
  const frameCount =
    countCode === 0 ? 1 : countCode === 1 || countCode === 2 ? 2 : packet.length > 1 ? packet[1]! & 0x3f : 0;
  const total = samplesPerFrame * frameCount;
  return total > 0 && total <= 5760 ? total : 960;
}

/**
 * Binary protocol (one WebSocket message per Opus packet):
 * [version:u8][codec:u8][clientId:u16be][durationSamples:u16be][opus...]
 */
export function encodeVoicePacket(frame: TS3VoiceFrame): Buffer {
  const header = Buffer.allocUnsafe(VOICE_PACKET_HEADER_BYTES);
  header.writeUInt8(VOICE_PACKET_VERSION, 0);
  header.writeUInt8(frame.codec, 1);
  header.writeUInt16BE(frame.clientId, 2);
  header.writeUInt16BE(opusPacketDurationSamples(frame.data), 4);
  return Buffer.concat([header, frame.data]);
}

export interface VoiceDownlinkController {
  cleanup(): void;
}

export function setupVoiceDownlink(
  wss: WebSocketServer,
  botManager: BotManager,
  logger: Logger,
): VoiceDownlinkController {
  const detachBySocket = new Map<WebSocket, () => void>();
  /** Listeners per bot. The nickname marker flips only on 0->1 and 1->0. */
  const listenersByBot = new Map<string, number>();

  const setWebVoice = (bot: BotInstance, botId: string, active: boolean) => {
    bot.setWebVoiceActive(active).catch((err) => {
      logger.warn({ err, botId, active }, "Failed to update web voice nickname marker");
    });
  };

  wss.on("connection", (ws) => {
    const botId = (ws as WebSocket & { voiceBotId?: string }).voiceBotId;
    const bot = botId ? botManager.getBot(botId) : undefined;
    if (!bot || !botId) {
      ws.close(1008, "bot not found");
      return;
    }

    const listeners = (listenersByBot.get(botId) ?? 0) + 1;
    listenersByBot.set(botId, listeners);
    if (listeners === 1) setWebVoice(bot, botId, true);

    const onVoiceFrame = (frame: TS3VoiceFrame) => {
      // WebCodecs supports the TeamSpeak Opus codecs only. Legacy codecs must
      // not be mislabeled as Opus on the wire.
      if ((frame.codec !== 4 && frame.codec !== 5) || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(encodeVoicePacket(frame), { binary: true });
      } catch (err) {
        logger.warn({ err, botId }, "Voice downlink send failed");
      }
    };
    const detach = () => {
      // close and error can both fire; only the first one counts down.
      if (!detachBySocket.has(ws)) return;
      bot.removeListener("voiceFrame", onVoiceFrame);
      detachBySocket.delete(ws);
      const remaining = (listenersByBot.get(botId) ?? 1) - 1;
      if (remaining > 0) {
        listenersByBot.set(botId, remaining);
      } else {
        listenersByBot.delete(botId);
        setWebVoice(bot, botId, false);
      }
    };
    detachBySocket.set(ws, detach);
    bot.on("voiceFrame", onVoiceFrame);
    ws.once("close", detach);
    ws.once("error", detach);
    logger.debug({ botId }, "Voice downlink client connected");
  });

  return {
    cleanup(): void {
      for (const [ws, detach] of detachBySocket) {
        detach();
        try {
          ws.close(1001, "server shutdown");
        } catch {
          // Socket may already be closed.
        }
      }
    },
  };
}
