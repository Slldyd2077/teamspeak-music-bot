import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  Client as TS3FullClient,
  generateIdentity as genTS3Identity,
  getUidFromPublicKey,
  identityFromString,
  sendTextMessage,
  listChannels,
  listClients,
  clientMove,
  getClientInfo,
  fileTransferDeleteFile,
  type Identity,
  type TextMessage,
  type ClientInfo,
  type ClientLeftViewEvent,
  type ClientMovedEvent,
  type VoiceData,
  type FileUploadInfo,
} from "@honeybbq/teamspeak-client";
import type { Logger } from "../logger.js";
import {
  detectServerProtocol,
  type ServerProtocol,
} from "./protocol-detect.js";
import { TS6HttpQuery } from "./http-query.js";
import {
  TrackingVoiceEndpointResolver,
  type ResolvedVoiceEndpoint,
} from "./voice-endpoint.js";

export { CODEC_OPUS_MUSIC } from "./voice.js";
export type { ServerProtocol } from "./protocol-detect.js";
export type { FileUploadInfo } from "@honeybbq/teamspeak-client";

/** Escape a string for use in TS3 ServerQuery-style commands. */
export function escapeTS3(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/ /g, "\\s")
    .replace(/\//g, "\\/")
    .replace(/\|/g, "\\p")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

export interface TS3ClientOptions {
  host: string;
  port: number; // Voice/virtual server port (default 9987)
  queryPort: number; // ServerQuery port (10011 for TS3, 10080 for TS6 HTTP)
  nickname: string;
  identity?: string; // Exported identity string, or undefined to generate new
  defaultChannel?: string;
  channelId?: string; // Numeric channel ID (takes precedence over defaultChannel)
  channelPassword?: string;
  serverPassword?: string;
  /** Force a specific protocol instead of auto-detecting. */
  serverProtocol?: ServerProtocol;
  /** API key for TS6 HTTP Query authentication. */
  ts6ApiKey?: string;
}

export interface TS3TextMessage {
  invokerName: string;
  invokerId: string;
  invokerUid: string;
  message: string;
  targetMode: number; // 1=private, 2=channel, 3=server
  invokerGroups: string[]; // sender's TS server-group ids; [] when not in view cache
}

/** One raw Opus packet received from another TeamSpeak client. */
export interface TS3VoiceFrame {
  clientId: number;
  codec: number;
  data: Buffer;
}

/** Voice packet signal; payload permits PCM-based speech detection. */
export interface TS3VoiceActivity {
  data: Buffer;
  clientId: number;
  codec: number;
  /** Stable TeamSpeak identity when the sender is present in the client view. */
  clientUid?: string;
}

/** Send acceptance only: an accepted UDP call does not confirm delivery. */
export interface TS3VoiceSendFailure {
  code?: string;
  consecutiveFailures: number;
  durationMs: number;
}

/** Sticky failure status lets playback stay paused when the terminal event
 * already fired during another track or an idle URL lookup. */
export type TS3VoiceSendResult = "accepted" | "retrying" | "failed" | "unavailable";

const VOICE_SEND_FAILURE_TIMEOUT_MS = 2_000;
const SAFE_SOCKET_ERROR_CODES = new Set([
  "ERR_SOCKET_DGRAM_NOT_RUNNING", "ERR_SOCKET_DGRAM_NOT_CONNECTED",
  "EPIPE", "ENOBUFS", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
  "ENETUNREACH", "ENETDOWN", "EACCES", "EPERM", "EINVAL", "EMSGSIZE",
  "EAGAIN", "ENOTCONN", "EBADF",
]);

function safeSocketErrorCode(error: unknown): string | undefined {
  try {
    if (!error || typeof error !== "object") return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && SAFE_SOCKET_ERROR_CODES.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

// Command notifications and UDP voice packets can be reordered in flight.
// Retain a leaving client's UID briefly so its final packet is still
// attributable; a new clientEnter for the same id cancels and overwrites it.
const VISIBLE_CLIENT_UID_RELEASE_GRACE_MS = 1_000;


/**
 * Map the library's TextMessage to our wrapper. Preserves invokerGroups (the
 * sender's TS server groups), which the library populates only when the sender
 * is in the bot's client-view cache; otherwise it is []. Used by the chat
 * command permission gate.
 */
export function toTS3TextMessage(msg: TextMessage): TS3TextMessage {
  return {
    invokerName: msg.invokerName,
    invokerId: String(msg.invokerID),
    invokerUid: msg.invokerUID,
    message: msg.message,
    targetMode: msg.targetMode,
    invokerGroups: msg.invokerGroups ?? [],
  };
}

export class TS3Client extends EventEmitter {
  private client: TS3FullClient | null = null;
  private identity: Identity;
  private readonly clientUid: string;
  private clientId = 0;
  private readonly visibleClientUids = new Map<number, string>();
  private readonly visibleClientUidReleaseTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();
  private logger: Logger;
  private disconnecting = false;
  private detectedProtocol: ServerProtocol = "unknown";
  private httpQuery: TS6HttpQuery | null = null;
  private udpErrorTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionGeneration = 0;
  private voiceFailureTimer: ReturnType<typeof setTimeout> | null = null;
  private voiceFailure: { code?: string; consecutiveFailures: number; startedAt: number } | null = null;
  private voiceEndpointResolver = new TrackingVoiceEndpointResolver();

  constructor(private options: TS3ClientOptions, logger: Logger) {
    super();
    this.logger = logger;

    if (options.identity) {
      this.identity = identityFromString(options.identity);
    } else {
      this.identity = genTS3Identity(8);
    }
    this.clientUid = getUidFromPublicKey(this.identity.publicKeyBase64());
  }

  /** The detected (or forced) server protocol after connect(). */
  getServerProtocol(): ServerProtocol {
    return this.detectedProtocol;
  }

  /** TS6 HTTP Query client (available after connecting to a TS6 server). */
  getHttpQuery(): TS6HttpQuery | null {
    return this.httpQuery;
  }

  async connect(): Promise<void> {
    // Reject invalid login names before discovery/UDP: TS requires 3–30
    // Unicode characters for non-SDK clients, not UTF-8 bytes or UTF-16 units.
    const nicknameLength = Array.from(this.options.nickname).length;
    if (!this.options.nickname.trim() || nicknameLength < 3 || nicknameLength > 30) {
      throw new Error("TeamSpeak nickname must contain 3–30 characters");
    }
    const generation = ++this.connectionGeneration;
    this.resetVoiceSendState();
    this.disconnecting = false;
    const voiceEndpointResolver = new TrackingVoiceEndpointResolver();
    this.voiceEndpointResolver = voiceEndpointResolver;
    this.clearVisibleClientUids();
    this.httpQuery = null;
    // Clean up any existing connection before creating a new one
    const previousClient = this.client;
    this.client = null;
    this.clientId = 0;
    if (previousClient) {
      this.logger.info("Cleaning up previous connection before reconnecting");
      try {
        await previousClient.disconnect();
      } catch {
        // Ignore errors during cleanup
      }
      if (generation !== this.connectionGeneration) return;
    }

    const addr = `${this.options.host}:${this.options.port}`;

    // Detect or use forced protocol
    if (this.options.serverProtocol && this.options.serverProtocol !== "unknown") {
      this.detectedProtocol = this.options.serverProtocol;
      this.logger.info(
        { addr, protocol: this.detectedProtocol },
        "Using forced server protocol",
      );
    } else {
      this.logger.info({ addr }, "Detecting server protocol (TS3/TS6)...");
      const detection = await detectServerProtocol(
        this.options.host,
        this.options.port,
        3000,
        { ts3QueryPort: 10011, ts6HttpPort: 10080 },
      );
      if (generation !== this.connectionGeneration) return;
      this.detectedProtocol = detection.protocol;
      if (this.detectedProtocol === "unknown") {
        this.logger.warn(
          { addr },
          "Could not detect server protocol (query ports 10011/10080 unreachable). " +
            "Will attempt voice connection anyway. Use serverProtocol option to force TS3 or TS6.",
        );
      } else {
        this.logger.info(
          { addr, protocol: this.detectedProtocol, queryPort: detection.queryPort },
          `Server protocol detected: ${this.detectedProtocol.toUpperCase()}`,
        );
      }
    }

    // Set up TS6 HTTP Query if applicable
    if (this.detectedProtocol === "ts6") {
      const queryPort = this.options.queryPort !== 10011 ? this.options.queryPort : 10080;
      this.httpQuery = new TS6HttpQuery({
        host: this.options.host,
        port: queryPort,
        apiKey: this.options.ts6ApiKey,
      });
    }

    this.logger.info(
      { addr, protocol: this.detectedProtocol },
      "Connecting to TeamSpeak server (full client protocol)",
    );

    // Throttle repeated "udp send error" warnings (fires every 20ms during playback if UDP breaks)
    let sdkClient: TS3FullClient | null = null;
    const isCurrent = () => sdkClient !== null && this.client === sdkClient &&
      this.connectionGeneration === generation && !this.disconnecting;
    let udpErrorCount = 0;
    let udpErrorCode: string | undefined;
    const throttledWarn = (msg: string, ...args: unknown[]) => {
      if (!isCurrent()) return;
      if (typeof msg === "string" && msg.includes("udp send error")) {
        udpErrorCount++;
        udpErrorCode = args.map(safeSocketErrorCode).find(code => code !== undefined) ?? udpErrorCode;
        if (udpErrorCount === 1) {
          this.logger.warn({ ...(udpErrorCode ? { code: udpErrorCode } : {}), count: 1 }, "udp send error");
          // After 2 seconds, log a summary and reset.
          // Clear any previous timer to avoid leaking it.
          if (this.udpErrorTimer) clearTimeout(this.udpErrorTimer);
          this.udpErrorTimer = setTimeout(() => {
            if (!isCurrent()) return;
            if (udpErrorCount > 1) {
              this.logger.warn({ ...(udpErrorCode ? { code: udpErrorCode } : {}), count: udpErrorCount }, "Repeated udp send error; connection may be lost");
            }
            udpErrorCount = 0;
            udpErrorCode = undefined;
            this.udpErrorTimer = null;
          }, 2000);
          this.udpErrorTimer.unref?.();
        }
        return;
      }
      this.logger.warn(msg);
    };

    sdkClient = new TS3FullClient(this.identity, addr, this.options.nickname, {
      // Forward server password to the protocol library so it can be
      // included in clientinit for password-protected servers
      serverPassword: this.options.serverPassword,
      resolver: voiceEndpointResolver,
      logger: {
        debug: (msg) => { if (isCurrent()) this.logger.debug(msg); },
        info: (msg) => { if (isCurrent()) this.logger.info(msg); },
        warn: throttledWarn,
        error: (msg) => { if (isCurrent()) this.logger.error(msg); },
      },
    });
    this.client = sdkClient;

    sdkClient.on("textMessage", (msg: TextMessage) => {
      if (!isCurrent()) return;
      if (msg.invokerID === this.clientId) return;
      this.emit("textMessage", toTS3TextMessage(msg));
    });

    sdkClient.on("voiceData", (voice: VoiceData) => {
      if (!isCurrent()) return;
      // The library normally suppresses our own packets; retain the explicit
      // guard so a future protocol change cannot make a bot duck itself.
      if (voice.clientId === this.clientId) return;
      const clientUid = this.visibleClientUids.get(voice.clientId);
      const activity: TS3VoiceActivity = {
        data: Buffer.from(voice.data),
        clientId: voice.clientId,
        codec: voice.codec,
        ...(clientUid ? { clientUid } : {}),
      };
      this.emit("voiceActivity", activity);
      // Web voice downlink needs the raw Opus packet: copy the subarray before
      // the UDP packet can be released by the protocol layer.
      const frame: TS3VoiceFrame = {
        clientId: voice.clientId,
        codec: voice.codec,
        data: Buffer.from(voice.data),
      };
      this.emit("voiceFrame", frame);
    });

    sdkClient.on("disconnected", (err) => {
      if (!isCurrent()) return;
      const code = safeSocketErrorCode(err);
      this.logger.warn(code ? { code } : {}, "Connection closed");
      ++this.connectionGeneration;
      this.resetVoiceSendState();
      this.client = null;
      this.clientId = 0;
      this.clearVisibleClientUids();
      this.emit("disconnected");
    });

    sdkClient.on("clientEnter", (info: ClientInfo) => {
      if (!isCurrent()) return;
      this.rememberVisibleClientUid(info.id, info.uid);
      this.logger.debug(
        { nickname: info.nickname, id: info.id },
        "Client entered"
      );
      this.emit("clientEnter", info);
    });

    sdkClient.on("clientLeave", (ev: ClientLeftViewEvent) => {
      if (!isCurrent()) return;
      this.releaseVisibleClientUid(ev.id);
      this.logger.debug({ id: ev.id }, "Client left");
      this.emit("clientLeave", ev);
    });

    sdkClient.on("clientMoved", (ev: ClientMovedEvent) => {
      if (!isCurrent()) return;
      this.logger.debug(
        { id: ev.id, targetChannelID: ev.targetChannelID.toString() },
        "Client moved"
      );
      this.emit("clientMoved", ev);
    });

    await sdkClient.connect();
    if (!isCurrent()) {
      // DNS/socket setup may finish after disconnect() closed the transport.
      // Close it again without waiting on command replies from a stale session.
      sdkClient.handler.close();
      return;
    }
    // Note: @honeybbq/teamspeak-client 0.2.x ships a universal clientinit
    // (client_version "3.?.? [Build: 5680278000]" + matching signature)
    // that works against both TS3 and TS6 servers. The old 3.6.2 monkey-
    // patch on handler.sendPacket was removed when we bumped to 0.2.1 — it
    // would have replaced the library's new correct version with a stale
    // signature and made TS6 handshakes fail.
    await sdkClient.waitConnected();
    if (!isCurrent()) return;
    this.clientId = sdkClient.clientID();
    this.voiceFramesSent = 0;
    this.logger.info(
      { clientId: this.clientId, protocol: this.detectedProtocol },
      `Logged in (visible client, ${this.detectedProtocol.toUpperCase()} server)`,
    );

    // Join channel by numeric ID (takes precedence) or by name
    if (this.options.channelId) {
      await this.joinChannel(this.options.channelId, this.options.channelPassword);
    } else if (this.options.defaultChannel) {
      await this.joinChannel(
        this.options.defaultChannel,
        this.options.channelPassword
      );
    }

    if (isCurrent()) this.emit("connected");
  }

  /**
   * Join a channel by id and let failures propagate.
   *
   * joinChannel() logs and swallows because it backs a chat command with nobody
   * to report back to. The web API needs the error so it can tell the user the
   * channel password was wrong — and moving as this client (rather than via a
   * ServerQuery admin) is what makes the server check the password at all.
   */
  async joinChannelById(cid: number, password?: string): Promise<void> {
    if (!this.client) throw new Error("not connected to TeamSpeak");
    await clientMove(this.client, this.clientId, BigInt(cid), password);
    this.logger.info({ cid }, "Joined channel by id");
  }

  async joinChannel(channelName: string, password?: string): Promise<void> {
    const client = this.client;
    if (!client || this.disconnecting) return;
    const clientId = this.clientId;
    const generation = this.connectionGeneration;
    const isCurrent = () => this.client === client && this.clientId === clientId &&
      this.connectionGeneration === generation && !this.disconnecting;

    const isNumeric = /^\d+$/.test(channelName);
    if (isNumeric) {
      try {
        await clientMove(client, clientId, BigInt(channelName), password);
        if (!isCurrent()) return;
        this.logger.info({ channelName }, "Joined channel");
      } catch (err) {
        if (isCurrent()) this.logger.error({ err, channelName }, "Failed to join channel");
      }
      return;
    }

    try {
      const channels = await listChannels(client);
      if (!isCurrent()) return;
      const channel = channels.find((ch) => ch.name === channelName);

      if (!channel) {
        this.logger.warn({ channelName }, "Channel not found");
        return;
      }

      await clientMove(client, clientId, channel.id, password);
      if (!isCurrent()) return;
      this.logger.info(
        { channelName, cid: channel.id.toString() },
        "Joined channel"
      );
    } catch (err) {
      if (isCurrent()) this.logger.error({ err, channelName }, "Failed to join channel");
    }
  }

  async sendTextMessage(
    message: string,
    targetMode: number = 2
  ): Promise<void> {
    if (!this.client) return;
    // targetMode 2 = channel, target 0 = current channel
    const target = targetMode === 2 ? BigInt(0) : BigInt(this.clientId);
    await sendTextMessage(this.client, targetMode, target, message);
  }

  async getClientsInChannel(): Promise<ClientInfo[]> {
    if (!this.client) return [];
    try {
      const allClients = await listClients(this.client);
      const myChannelId = this.client.channelID();
      return allClients.filter((c) => c.channelID === myChannelId);
    } catch {
      return [];
    }
  }

  /**
   * Resolve a client's CURRENT server groups by client id, server-wide (works
   * regardless of channel/view) via a targeted `clientinfo` query. The raw
   * `client_servergroups` field is a comma-separated list (same field
   * `listClients` parses). Returns [] if the client can't be resolved or the
   * query fails, so callers fail closed.
   */
  async getClientServerGroups(clid: number): Promise<string[]> {
    if (!this.client) return [];
    try {
      const info = await getClientInfo(this.client, clid);
      // `client_servergroups`: comma-separated server-group ids (verified in
      // @honeybbq/teamspeak-client dist/index.mjs; listClients parses the same).
      const raw = info.client_servergroups ?? "";
      return raw ? raw.split(",") : [];
    } catch {
      return [];
    }
  }

  // --- Raw command & file transfer pass-through ---

  async execCommand(cmd: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.execCommand(cmd);
  }

  /** Fire a command without waiting for the server's response. */
  async sendCommandNoWait(cmd: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.sendCommandNoWait(cmd);
  }

  async execCommandWithResponse(cmd: string): Promise<Record<string, string>[]> {
    if (!this.client) throw new Error("Not connected");
    return this.client.execCommandWithResponse(cmd);
  }

  async fileTransferInitUpload(
    channelID: bigint,
    path: string,
    password: string,
    size: bigint,
    overwrite = true,
  ): Promise<FileUploadInfo> {
    if (!this.client) throw new Error("Not connected");
    return this.client.fileTransferInitUpload(channelID, path, password, size, overwrite);
  }

  async uploadFileData(host: string, info: FileUploadInfo, data: Readable): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.uploadFileData(host, info, data);
  }

  async fileTransferDeleteFile(channelID: bigint, paths: string[]): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await fileTransferDeleteFile(this.client, channelID, paths);
  }

  /** The server host (needed for file transfer TCP connections). */
  getHost(): string {
    return this.options.host;
  }

  /** The current channel ID of this client. */
  getChannelId(): bigint {
    if (!this.client) return 0n;
    return this.client.channelID();
  }

  private voiceFramesSent = 0;

  sendVoiceData(opusFrame: Buffer): TS3VoiceSendResult {
    const client = this.client;
    if (!client || this.disconnecting) return "unavailable";
    try {
      client.sendVoice(opusFrame, 5);
    } catch (err) {
      if (this.voiceFailure) {
        this.voiceFailure.consecutiveFailures++;
        this.voiceFailure.code = safeSocketErrorCode(err) ?? this.voiceFailure.code;
        return this.voiceFailureTimer ? "retrying" : "failed";
      }
      const code = safeSocketErrorCode(err);
      const failure = this.voiceFailure = {
        ...(code ? { code } : {}), consecutiveFailures: 1, startedAt: Date.now(),
      };
      const generation = this.connectionGeneration;
      this.voiceFailureTimer = setTimeout(() => {
        if (this.client !== client || this.connectionGeneration !== generation ||
          this.disconnecting || this.voiceFailure !== failure) return;
        this.voiceFailureTimer = null;
        const event = this.voiceFailureDetails(failure);
        this.logger.error(event, "Voice sends have failed continuously; pausing playback is required");
        this.emit("voiceSendFailed", event);
      }, VOICE_SEND_FAILURE_TIMEOUT_MS);
      this.voiceFailureTimer.unref?.();
      const event = this.voiceFailureDetails(failure);
      this.logger.warn(event, "Voice send failed");
      this.emit("voiceSendFailure", event);
      return "retrying";
    }
    this.voiceFramesSent++;
    if (this.voiceFramesSent === 1) {
      this.logger.info({ opusBytes: opusFrame.length, clientId: this.clientId }, "First voice packet accepted by TeamSpeak client");
    }
    if (this.voiceFailure) {
      const event = this.voiceFailureDetails(this.voiceFailure);
      this.clearVoiceFailure();
      this.logger.info(event, "Voice send recovered");
      this.emit("voiceSendRecovered", event);
    }
    return "accepted";
  }

  private voiceFailureDetails(failure: NonNullable<TS3Client["voiceFailure"]>): TS3VoiceSendFailure {
    return {
      ...(failure.code ? { code: failure.code } : {}),
      consecutiveFailures: failure.consecutiveFailures,
      durationMs: Math.max(0, Date.now() - failure.startedAt),
    };
  }

  private clearVoiceFailure(): void {
    if (this.voiceFailureTimer) clearTimeout(this.voiceFailureTimer);
    this.voiceFailureTimer = null;
    this.voiceFailure = null;
  }

  private resetVoiceSendState(): void {
    this.clearVoiceFailure();
    this.voiceFramesSent = 0;
    if (this.udpErrorTimer) clearTimeout(this.udpErrorTimer);
    this.udpErrorTimer = null;
  }

  getIdentityExport(): string {
    return this.identity.toString();
  }

  getClientId(): number {
    return this.clientId;
  }

  /** Actual endpoint selected by the SDK's SRV/TSDNS discovery and DNS lookup. */
  getResolvedVoiceEndpoint(): ResolvedVoiceEndpoint | null {
    return this.voiceEndpointResolver.getEndpoint();
  }

  /** Stable identity of this managed TeamSpeak client. */
  getClientUid(): string {
    return this.clientUid;
  }

  private rememberVisibleClientUid(clientId: number, clientUid: string): void {
    const pendingRelease = this.visibleClientUidReleaseTimers.get(clientId);
    if (pendingRelease) clearTimeout(pendingRelease);
    this.visibleClientUidReleaseTimers.delete(clientId);

    if (clientId > 0 && clientUid) {
      this.visibleClientUids.set(clientId, clientUid);
    } else {
      this.visibleClientUids.delete(clientId);
    }
  }

  private releaseVisibleClientUid(clientId: number): void {
    const clientUid = this.visibleClientUids.get(clientId);
    if (!clientUid) return;

    const previous = this.visibleClientUidReleaseTimers.get(clientId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (this.visibleClientUids.get(clientId) === clientUid) {
        this.visibleClientUids.delete(clientId);
      }
      this.visibleClientUidReleaseTimers.delete(clientId);
    }, VISIBLE_CLIENT_UID_RELEASE_GRACE_MS);
    timer.unref?.();
    this.visibleClientUidReleaseTimers.set(clientId, timer);
  }

  private clearVisibleClientUids(): void {
    for (const timer of this.visibleClientUidReleaseTimers.values()) {
      clearTimeout(timer);
    }
    this.visibleClientUidReleaseTimers.clear();
    this.visibleClientUids.clear();
  }

  disconnect(): void {
    const generation = ++this.connectionGeneration;
    this.resetVoiceSendState();
    const client = this.client;
    this.client = null;
    if (client && !this.disconnecting) {
      this.disconnecting = true;
      client.disconnect().catch(() => {}).finally(() => {
        if (generation === this.connectionGeneration) this.disconnecting = false;
      });
    }
    this.clientId = 0;
    this.clearVisibleClientUids();
    this.httpQuery = null;
    this.detectedProtocol = "unknown";
    this.logger.info("Disconnected from TeamSpeak server");
  }
}
