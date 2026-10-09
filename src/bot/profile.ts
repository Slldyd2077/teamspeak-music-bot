import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import axios from "axios";
import { TS3Client, escapeTS3 } from "../ts-protocol/client.js";
import { HttpQueryError } from "../ts-protocol/http-query.js";
import type { ProfileConfig } from "../data/database.js";
import type { QueuedSong } from "../audio/queue.js";
import type { Logger } from "../logger.js";

const TS3_NICKNAME_MAX = 30;
/** Shown in the bot's nickname while a browser is on the channel voice link. */
const WEB_VOICE_MARKER = "<WEB通讯> ";
/** TS3 avatar max size — server default is ~300 KB. Use 200 KB to be safe. */
const AVATAR_MAX_BYTES = 200 * 1024;
/** Timeout for file-transfer operations (upload / delete). */
const FILE_TRANSFER_TIMEOUT_MS = 6000;

interface ProfileUpdateContext {
  generation: number;
  channelGeneration: number;
  clientId: number;
  httpQuery: ReturnType<TS3Client["getHttpQuery"]>;
}

/**
 * Manages the bot's TeamSpeak presence (avatar, description, nickname,
 * away status, channel description, now-playing messages).
 *
 * Every update is permission-safe: if a feature fails due to insufficient
 * server permissions, it silently disables itself until the next reconnect.
 */
export class BotProfileManager {
  private tsClient: TS3Client;
  private logger: Logger;
  private config: ProfileConfig;
  private defaultNickname: string;
  private customAvatar: Buffer | null = null;
  /** True while at least one browser is subscribed to this bot's voice downlink. */
  private webVoiceActive = false;
  /**
   * Tracks the last song handed to onSongChange. null means stopped/idle.
   * Used by setCustomAvatar to decide whether the new buffer should be
   * pushed immediately (idle) or wait for the next stop event (playing).
   */
  private currentSong: QueuedSong | null = null;
  /**
   * Channel whose description currently holds our now-playing text, or null
   * if we have not written one. Remembered so that when the bot is moved we
   * can still clean up the channel it was taken out of (#159) — by then
   * getChannelId() already reports the new channel.
   */
  private channelDescCid: bigint | null = null;

  /** Per-feature permission-denied flags. Reset on reconnect. */
  private permDenied = {
    avatar: false,
    description: false,
    nickname: false,
    awayStatus: false,
    channelDesc: false,
    nowPlayingMsg: false,
  };

  /**
   * Monotonically increasing generation counter. Incremented on every
   * onSongChange / onConnect call. Long-running operations (avatar
   * download/upload) check this before committing their result — if
   * the generation changed, a newer update has superseded them.
   */
  private generation = 0;
  /** Channel moves supersede channel writes without cancelling avatar work. */
  private channelGeneration = 0;

  constructor(
    tsClient: TS3Client,
    logger: Logger,
    config: ProfileConfig,
    defaultNickname: string,
  ) {
    this.tsClient = tsClient;
    this.logger = logger.child({ component: "profile" });
    this.config = { ...config };
    this.defaultNickname = defaultNickname;
  }

  // --- Public API ---

  /**
   * Mark the bot as carrying a browser voice call, so people in the channel
   * can tell the sound is a web user rather than the music player.
   *
   * Unlike the now-playing nickname this is not decoration, so it applies even
   * when `nicknameEnabled` is off — it is the only cue that someone is
   * listening/speaking through the bot.
   */
  async setWebVoiceActive(active: boolean): Promise<void> {
    if (this.webVoiceActive === active) return;
    this.webVoiceActive = active;
    // forceNickname matters on the way *out*: with nicknameEnabled off and the
    // marker just cleared, nothing else would ask for a nickname write and the
    // bot would sit there tagged <WEB通讯> forever.
    await this.updateClientProperties(this.currentSong, this.createUpdateContext(), { forceNickname: true });
  }

  /**
   * Store a persisted custom avatar WITHOUT touching TeamSpeak (#148).
   *
   * Used during BotInstance construction, when the TS connection does not
   * exist yet: setCustomAvatar would immediately fire the three-step file
   * transfer (fileTransferInitUpload → uploadFileData → clientupdate) against
   * a client that has not connected, so the upload always failed and the
   * saved avatar never appeared. onConnect() re-applies this.customAvatar
   * once the handshake completes, so loading it silently here loses nothing.
   */
  loadCustomAvatar(buffer: Buffer | null): void {
    this.customAvatar = buffer;
  }

  /**
   * Set/clear the persistent idle avatar. Pass null to remove.
   *
   * If the bot is currently in an idle state (no song playing OR
   * avatarEnabled is off), the new buffer is pushed to TS3 right away;
   * otherwise the cover-art sync is in charge until the next stop event,
   * at which point clearAvatar restores from this.customAvatar.
   */
  setCustomAvatar(buffer: Buffer | null): void {
    this.customAvatar = buffer;
    const idle = this.currentSong === null || !this.config.avatarEnabled;
    if (!idle) return;
    const gen = ++this.generation;
    if (buffer && buffer.length > 0) {
      void this.applyIdleAvatar(gen);
    } else {
      void this.clearAvatar(gen);
    }
  }

  /**
   * Called when a new song starts playing (song != null) or playback
   * stops (song == null).
   *
   * Commands are serialized to avoid overwhelming the TS3 command queue.
   * Nickname + away status are merged into a single `clientupdate` call.
   *
   * A generation counter guards against stale updates: if a newer
   * onSongChange fires while the avatar is still downloading, the old
   * update is discarded.
   */
  async onSongChange(song: QueuedSong | null): Promise<void> {
    const gen = ++this.generation;
    this.channelGeneration++;
    this.currentSong = song;
    const context = this.createUpdateContext();

    // 1. Avatar first — file transfer uses its own response tracker and
    //    must run before sendCommandNoWait calls whose orphaned responses
    //    could confuse the command matcher.
    await this.updateAvatar(song?.coverUrl ?? null, gen);
    if (!this.isCurrentUpdate(context)) return;

    // 2. Checked clientupdate sent by the visible client itself.
    await this.updateClientProperties(song, context);
    if (!this.isCurrentUpdate(context)) return;
    // 3. Description (clientedit on TS3, httpQuery on TS6)
    await this.updateDescription(song, context);
    if (!this.isCurrentUpdate(context)) return;
    // 4. Checked channel description update.
    await this.updateChannelDescription(song, context);
    if (!this.isCurrentUpdate(context)) return;
    // 5. Now-playing chat message
    if (song) await this.sendNowPlayingMessage(song);
  }

  /** Reset permission-denied flags and bump generation on new connection. */
  onConnect(): void {
    this.generation++;
    this.channelGeneration++;
    this.currentSong = null;
    // Channel ids are per-server; never carry one across a (re)connect.
    this.channelDescCid = null;
    this.permDenied = {
      avatar: false,
      description: false,
      nickname: false,
      awayStatus: false,
      channelDesc: false,
      nowPlayingMsg: false,
    };
    // No song is playing on a fresh connect, so the matrix says the
    // custom avatar should be visible regardless of avatarEnabled.
    if (this.customAvatar) {
      const gen = this.generation;
      void this.applyIdleAvatar(gen);
    }
  }

  /**
   * Called when the bot itself has been moved to another channel (#159).
   * Clears the now-playing text from the channel it left and, if a song is
   * playing, writes it to the channel it is in now.
   */
  async onChannelMoved(newChannelId: bigint): Promise<void> {
    if (!this.config.channelDescEnabled || this.permDenied.channelDesc) return;
    const oldChannelId = this.channelDescCid;
    if (oldChannelId === newChannelId) return;
    this.channelGeneration++;
    const context = this.createUpdateContext();
    const song = this.currentSong;
    try {
      if (oldChannelId !== null) {
        if (!await this.writeChannelDescription(oldChannelId, "", context)) return;
        this.channelDescCid = null;
      }
    } catch (err) {
      if (this.isCurrentChannelUpdate(context)) this.handleFeatureError("channelDesc", err);
      return;
    }
    if (song) {
      await this.updateChannelDescription(song, context, newChannelId);
    }
  }

  getConfig(): ProfileConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<ProfileConfig>): void {
    Object.assign(this.config, partial);
  }

  // --- Internal update methods ---

  private async updateAvatar(coverUrl: string | null, gen: number): Promise<void> {
    if (!this.config.avatarEnabled || this.permDenied.avatar) return;
    try {
      if (!coverUrl) {
        await this.clearAvatar(gen);
        return;
      }
      // Request a thumbnail from the CDN to stay within TS3's avatar size limit.
      const thumbUrl = this.thumbnailUrl(coverUrl);
      const imageBuffer = await this.downloadImage(thumbUrl);

      // Check generation after the slow download — bail if superseded.
      if (this.generation !== gen) return;

      if (!imageBuffer || imageBuffer.length === 0) return;
      if (imageBuffer.length > AVATAR_MAX_BYTES) {
        this.logger.warn(
          { bytes: imageBuffer.length, max: AVATAR_MAX_BYTES },
          "Cover image still too large after resize — skipping avatar update",
        );
        return;
      }

      // Wrap the file-transfer sequence with a timeout — the TS3
      // full-client file transfer can silently hang.
      const start = Date.now();
      await this.withTimeout(this.doAvatarUpload(imageBuffer), FILE_TRANSFER_TIMEOUT_MS);
      this.logger.info(
        { bytes: imageBuffer.length, elapsedMs: Date.now() - start },
        "Avatar updated",
      );
    } catch (err) {
      this.handleFeatureError("avatar", err);
    }
  }

  /**
   * Three-step upload. Each step is logged so the log can tell us whether
   * a broken/loading avatar on the client is from:
   *   (a) init failing (no permission)
   *   (b) file transfer hanging on TCP 30033
   *   (c) client_flag_avatar not applying
   * If (b) happens, the avatar MD5 would still be set in the past — leaving
   * clients showing a placeholder. The flag is now only set after the TCP
   * transfer resolves.
   */
  private async doAvatarUpload(imageBuffer: Buffer): Promise<void> {
    const host = this.tsClient.getHost();
    this.logger.debug({ bytes: imageBuffer.length, host }, "Avatar: init file transfer");
    const info = await this.tsClient.fileTransferInitUpload(
      0n, "/avatar", "", BigInt(imageBuffer.length), true,
    );
    this.logger.debug({ bytes: imageBuffer.length }, "Avatar: uploading file data");
    await this.tsClient.uploadFileData(host, info, Readable.from(imageBuffer));
    const md5 = createHash("md5").update(imageBuffer).digest("hex");
    this.logger.debug({ md5 }, "Avatar: setting client_flag_avatar");
    await this.tsClient.sendCommandNoWait(`clientupdate client_flag_avatar=${escapeTS3(md5)}`);
  }

  private async clearAvatar(gen: number): Promise<void> {
    if (this.customAvatar && this.customAvatar.length > 0) {
      await this.applyIdleAvatar(gen);
      return;
    }
    try {
      await this.withTimeout(
        this.tsClient.fileTransferDeleteFile(0n, ["/avatar"]),
        FILE_TRANSFER_TIMEOUT_MS,
      );
    } catch {
      // File may not exist or transfer timed out — that's fine
    }
    if (this.generation !== gen) return;
    try {
      await this.tsClient.sendCommandNoWait("clientupdate client_flag_avatar=");
    } catch (err) {
      this.handleFeatureError("avatar", err);
    }
  }

  private async applyIdleAvatar(gen: number): Promise<void> {
    if (!this.customAvatar || this.customAvatar.length === 0) return;
    if (this.permDenied.avatar) return;
    try {
      await this.withTimeout(this.doAvatarUpload(this.customAvatar), FILE_TRANSFER_TIMEOUT_MS);
      if (this.generation !== gen) return;
      this.logger.info({ bytes: this.customAvatar.length }, "Idle (custom) avatar applied");
    } catch (err) {
      this.handleFeatureError("avatar", err);
    }
  }

  private async updateDescription(song: QueuedSong | null, context: ProfileUpdateContext): Promise<void> {
    if (!this.config.descriptionEnabled || this.permDenied.description) return;
    if (!this.isCurrentUpdate(context)) return;

    try {
      const text = song
        ? `${song.name} - ${song.artist} [${song.album}]`
        : "";

      const clid = context.clientId;
      if (clid <= 0) return;

      const httpQuery = context.httpQuery;

      if (httpQuery) {
        // IMPORTANT:
        // clientUpdate() would modify the HTTP Query/serveradmin client.
        // Explicitly edit the real visible music client instead.
        const result = await httpQuery.clientEdit(clid, {
          client_description: text,
        });
        if (!this.isCurrentUpdate(context)) return;

        this.logger.info(
          { status: result.status, clid },
          "Description updated",
        );
      } else {
        await this.withTimeout(
          this.tsClient.execCommand(
            `clientedit clid=${clid} client_description=${escapeTS3(text)}`,
          ),
          5000,
        );
        if (!this.isCurrentUpdate(context)) return;

        this.logger.info({ clid }, "Description updated");
      }
    } catch (err) {
      if (this.isCurrentUpdate(context)) this.handleFeatureError("description", err);
    }
  }

  /**
   * Build and send a single `clientupdate` command that sets nickname
   * and away status together. The full client sends this command on both
   * TS3 and TS6, with a return code so permission failures are observable.
   */
  private async updateClientProperties(
    song: QueuedSong | null,
    context: ProfileUpdateContext,
    options: { forceNickname?: boolean } = {},
  ): Promise<void> {
    if (!this.isCurrentUpdate(context) || context.clientId <= 0) return;
    const rawProps: Record<string, string | number> = {};

    // --- Nickname ---
    // The web-voice marker has to drive this too, otherwise turning it on or off
    // would never reach TeamSpeak on bots that keep nicknameEnabled off.
    const wantNickname = this.config.nicknameEnabled || this.webVoiceActive || options.forceNickname;
    if (wantNickname && !this.permDenied.nickname) {
      const nickname = this.renderNickname(song);
      if (nickname) {
        rawProps.client_nickname = nickname;
      }
    }

    // --- Away status ---
    if (this.config.awayStatusEnabled && !this.permDenied.awayStatus) {
      // A browser call keeps the bot busy without going through the queue:
      // /api/player/:botId/live drives the player directly, so `song` stays null
      // and the bot used to sit there flagged AFK "\u7B49\u5F85\u64AD\u653E" for the whole call.
      if (song || this.webVoiceActive) {
        rawProps.client_away = 0;
      } else {
        rawProps.client_away = 1;
        rawProps.client_away_message = "等待播放";
      }
    }

    if (Object.keys(rawProps).length === 0) return;

    try {
      // clientupdate modifies whichever connection sends the command.
      // Therefore it must be sent by the real full client, NOT HTTP Query.
      const parts = Object.entries(rawProps).map(([key, value]) =>
        typeof value === "string"
          ? `${key}=${escapeTS3(value)}`
          : `${key}=${value}`,
      );

      await this.withTimeout(
        this.tsClient.execCommand(`clientupdate ${parts.join(" ")}`),
        5000,
      );
      if (!this.isCurrentUpdate(context)) return;

      this.logger.info(
        {
          clid: context.clientId,
          props: Object.keys(rawProps),
        },
        "Client properties updated (nickname + away)",
      );
    } catch (err) {
      if (!this.isCurrentUpdate(context)) return;
      if (rawProps.client_nickname !== undefined) this.handleFeatureError("nickname", err);
      if (rawProps.client_away !== undefined) this.handleFeatureError("awayStatus", err);
    }
  }

  /**
   * Full nickname for the current state: the web-voice marker (when active) in
   * front of the now-playing or plain name.
   *
   * The marker costs 12 of the 30 bytes, so the base name is built inside what
   * is left rather than joined and trimmed afterwards, which could slice the
   * marker itself in half.
   */
  private renderNickname(song: QueuedSong | null): string | null {
    const marker = this.webVoiceActive ? WEB_VOICE_MARKER : "";
    const budget = TS3_NICKNAME_MAX - Buffer.byteLength(marker, "utf8");
    if (budget <= 0) return null;

    const decorated = song && this.config.nicknameEnabled
      ? this.buildNickname(song, budget)
      : null;
    // buildNickname returns null when the decoration alone busts the budget;
    // fall back to the plain name so the marker still shows.
    return marker + (decorated ?? this.truncateUtf8(this.defaultNickname, budget));
  }

  private buildNickname(song: QueuedSong, maxBytes: number): string | null {
    const songInfo = `${song.name} - ${song.artist}`;
    const prefix = "\u266A "; // ♪
    const sep = " - ";
    const suffix = `${sep}${this.defaultNickname}`;

    const overheadBytes = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
    if (overheadBytes >= maxBytes) {
      // Default nickname alone is too long with decoration — skip
      return null;
    }

    const maxSongBytes = maxBytes - overheadBytes;
    const truncated = this.truncateUtf8(songInfo, maxSongBytes);
    // Nothing of the title survived the budget (happens once the web-voice
    // marker is also in play) — let the caller fall back to the plain name.
    if (!truncated) return null;
    return `${prefix}${truncated}${suffix}`;
  }

  /**
   * Truncate a string so its UTF-8 byte length does not exceed maxBytes.
   * Appends an ellipsis if truncation occurred, taking its byte cost
   * into account. Never splits a multi-byte character.
   */
  private truncateUtf8(str: string, maxBytes: number): string {
    // Must never hand back more than maxBytes: this used to return the 3-byte
    // ellipsis for any budget, which pushed the nickname past the TS3 limit
    // once the web-voice marker took a bite out of it.
    if (maxBytes <= 0) return "";
    if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
    const ellipsis = "\u2026"; // …
    const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8"); // 3
    const target = maxBytes - ellipsisBytes;
    if (target <= 0) return maxBytes >= ellipsisBytes ? ellipsis : "";
    // Walk characters, accumulating byte length
    let byteLen = 0;
    let end = 0;
    for (const ch of str) {
      const chBytes = Buffer.byteLength(ch, "utf8");
      if (byteLen + chBytes > target) break;
      byteLen += chBytes;
      end += ch.length; // ch.length handles surrogate pairs
    }
    return str.slice(0, end) + ellipsis;
  }

  private async updateChannelDescription(
    song: QueuedSong | null,
    context: ProfileUpdateContext,
    targetChannelId?: bigint,
  ): Promise<void> {
    if (!this.config.channelDescEnabled || this.permDenied.channelDesc) return;
    if (!this.isCurrentChannelUpdate(context) || context.clientId <= 0) return;

    try {
      // A stop already knows which channel to clear if a write succeeded.
      // Avoid a needless client-list lookup that could prevent that cleanup.
      let channelId = !song && this.channelDescCid !== null
        ? this.channelDescCid
        : targetChannelId ?? this.tsClient.getChannelId();

      // TS6 full-client may report channelID() as 0 even after the
      // visible music client has already joined a channel.
      // Fall back to HTTP Query and resolve our real clid -> cid.
      if (channelId === 0n) {
        const httpQuery = context.httpQuery;
        const clid = context.clientId;

        if (httpQuery && clid > 0) {
          const result = await httpQuery.clientList();
          if (!this.isCurrentChannelUpdate(context)) return;

          const payload = result.body as {
            body?: Array<Record<string, string>>;
          };

          const me = payload?.body?.find(
            (client) => Number(client.clid) === clid,
          );

          if (me?.cid) {
            channelId = BigInt(me.cid);

            this.logger.info(
              {
                clid,
                cid: channelId.toString(),
              },
              "Resolved channel ID via HTTP Query",
            );
          }
        }
      }

      if (!song) {
        if (channelId <= 0n) return;
        if (await this.writeChannelDescription(channelId, "", context)) this.channelDescCid = null;
        return;
      }

      if (channelId <= 0n) return;

      const lines = [
        `♪ 正在播放: ${song.name} - ${song.artist}`,
        `专辑: ${song.album}`,
        `平台: ${song.platform}`,
      ];

      // HTTP Query uses a normal JSON string, so use real newlines here.
      const desc = lines.join("\n");

      if (await this.writeChannelDescription(channelId, desc, context)) this.channelDescCid = channelId;
    } catch (err) {
      if (this.isCurrentChannelUpdate(context)) this.handleFeatureError("channelDesc", err);
    }
  }

  /** Both move cleanup and ordinary writes use the same checked transport. */
  private async writeChannelDescription(
    channelId: bigint,
    description: string,
    context: ProfileUpdateContext,
  ): Promise<boolean> {
    if (!this.isCurrentChannelUpdate(context)) return false;
    let status: number | undefined;
    if (context.httpQuery) {
      const result = await context.httpQuery.channelEdit(Number(channelId), {
        channel_description: description,
      });
      status = result.status;
    } else {
      await this.withTimeout(
        this.tsClient.execCommand(
          `channeledit cid=${channelId} channel_description=${escapeTS3(description)}`,
        ),
        5000,
      );
    }
    if (!this.isCurrentChannelUpdate(context)) return false;
    this.logger.info(
      { status, cid: channelId.toString() },
      description ? "Channel description updated" : "Channel description cleared",
    );
    return true;
  }

  private async sendNowPlayingMessage(song: QueuedSong): Promise<void> {
    if (!this.config.nowPlayingMsgEnabled || this.permDenied.nowPlayingMsg) return;
    try {
      const text = `\u266A \u6B63\u5728\u64AD\u653E: ${song.name} - ${song.artist} [${song.album}]`;
      await this.tsClient.sendTextMessage(text);
    } catch (err) {
      this.handleFeatureError("nowPlayingMsg", err);
    }
  }

  // --- Helpers ---

  private createUpdateContext(): ProfileUpdateContext {
    return {
      generation: this.generation,
      channelGeneration: this.channelGeneration,
      clientId: this.tsClient.getClientId(),
      httpQuery: this.tsClient.getHttpQuery(),
    };
  }

  private isCurrentUpdate(context: ProfileUpdateContext): boolean {
    return context.generation === this.generation &&
      context.clientId === this.tsClient.getClientId() &&
      context.httpQuery === this.tsClient.getHttpQuery();
  }

  private isCurrentChannelUpdate(context: ProfileUpdateContext): boolean {
    return this.isCurrentUpdate(context) && context.channelGeneration === this.channelGeneration;
  }

  /**
   * Append CDN resize parameters to get a thumbnail suitable for TS3 avatars.
   * NetEase and QQ Music CDNs support URL-based image resizing.
   * BiliBili and YouTube covers fall through to the size-check guard.
   */
  private thumbnailUrl(url: string): string {
    if (url.includes("music.126.net") || url.includes("netease")) {
      return url.includes("?") ? url : `${url}?param=200y200`;
    }
    if (url.includes("qqmusic") || url.includes("qq.com")) {
      return url.replace(/\/\d+$/, "/200");
    }
    if (url.includes("bilivideo") || url.includes("hdslb")) {
      // BiliBili CDN supports @<w>w_<h>h suffix
      return url.includes("@") ? url : `${url}@200w_200h`;
    }
    return url;
  }

  private async downloadImage(url: string): Promise<Buffer | null> {
    try {
      const resp = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 8000,
        maxContentLength: 2 * 1024 * 1024, // 2 MB cap
      });
      return Buffer.from(resp.data);
    } catch (err) {
      this.logger.warn({ err, url }, "Failed to download cover image");
      return null;
    }
  }

  /** Race a promise against a timeout. */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
      ),
    ]);
  }

  private handleFeatureError(
    feature: keyof typeof this.permDenied,
    err: unknown,
  ): void {
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    const status = err instanceof HttpQueryError ? err.status : undefined;
    const body = err instanceof HttpQueryError ? err.body : undefined;
    // Disable the feature for this session on unrecoverable errors:
    // - permission / insufficient → server denies the action
    // - invalid parameter → command not supported by this protocol
    // - HTTP 401/403 → TS6 server rejects the API key/role
    // - HTTP 400 → bad parameter; retrying on every song change is wasteful
    const isUnrecoverable =
      msg.includes("permission") ||
      msg.includes("insufficient") ||
      msg.includes("invalid parameter") ||
      status === 400 ||
      status === 401 ||
      status === 403;
    if (isUnrecoverable) {
      this.permDenied[feature] = true;
      this.logger.info(
        { feature, status, body, reason: msg },
        "Feature disabled for this session (will retry after reconnect)",
      );
    } else {
      this.logger.warn({ feature, status, body, err }, "Profile update failed");
    }
  }
}
