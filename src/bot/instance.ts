import { EventEmitter } from "node:events";
import {
  TS3Client,
  type TS3ClientOptions,
  type TS3TextMessage,
} from "../ts-protocol/client.js";
import { AudioPlayer } from "../audio/player.js";
import { PlayQueue, PlayMode, type QueuedSong } from "../audio/queue.js";
import type { MusicProvider } from "../music/provider.js";
import {
  parseCommand,
  isAdminCommand,
  type ParsedCommand,
} from "./commands.js";
import type { Logger } from "../logger.js";
import type { BotDatabase, ProfileConfig } from "../data/database.js";
import type { BotConfig } from "../data/config.js";
import { BotProfileManager } from "./profile.js";
import type { AvatarStore } from "../data/avatars.js";

export interface BotInstanceOptions {
  id: string;
  name: string;
  tsOptions: TS3ClientOptions;
  neteaseProvider: MusicProvider;
  qqProvider: MusicProvider;
  bilibiliProvider: MusicProvider;
  youtubeProvider: MusicProvider;
  database: BotDatabase;
  config: BotConfig;
  logger: Logger;
  avatarStore: AvatarStore;
}

export interface BotStatus {
  id: string;
  name: string;
  connected: boolean;
  playing: boolean;
  paused: boolean;
  currentSong: QueuedSong | null;
  queueSize: number;
  volume: number;
  playMode: PlayMode;
  elapsed: number; // ground truth elapsed seconds from frame count
}

export class BotInstance extends EventEmitter {
  readonly id: string;
  name: string;

  private tsClient: TS3Client;
  private player: AudioPlayer;
  private queue: PlayQueue;
  private neteaseProvider: MusicProvider;
  private qqProvider: MusicProvider;
  private bilibiliProvider: MusicProvider;
  private youtubeProvider: MusicProvider;
  private database: BotDatabase;
  private config: BotConfig;
  private logger: Logger;
  private avatarStore: AvatarStore;
  private connected = false;
  private disconnectEmitted = false;
  private voteSkipUsers = new Set<string>();
  private isAdvancing = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private channelUserCount = 0;
  private profileManager: BotProfileManager;
  private isFmMode = false;

  constructor(options: BotInstanceOptions) {
    super();
    this.id = options.id;
    this.name = options.name;
    this.neteaseProvider = options.neteaseProvider;
    this.qqProvider = options.qqProvider;
    this.bilibiliProvider = options.bilibiliProvider;
    this.youtubeProvider = options.youtubeProvider;
    this.database = options.database;
    this.config = options.config;
    this.logger = options.logger.child({ botId: this.id });
    this.avatarStore = options.avatarStore;

    this.tsClient = new TS3Client(options.tsOptions, this.logger);
    this.player = new AudioPlayer(this.logger);
    this.queue = new PlayQueue();

    const profileConfig = this.database.getProfileConfig(this.id);
    this.profileManager = new BotProfileManager(
      this.tsClient,
      this.logger,
      profileConfig,
      options.tsOptions.nickname,
    );

    // Best-effort: a corrupted/locked avatar file must not block bot startup.
    try {
      const relPath = this.database.getCustomAvatarPath(this.id);
      if (relPath) {
        const buf = this.avatarStore.read(relPath);
        if (buf) this.profileManager.setCustomAvatar(buf);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to load custom avatar — skipping");
    }

    this.setupPlayerEvents();
    this.setupTsEvents();
  }

  private setupPlayerEvents(): void {
    this.player.on("frame", (opusFrame: Buffer) => {
      this.tsClient.sendVoiceData(opusFrame);
    });

    this.player.on("trackEnd", () => {
      this.logger.debug("Track ended, advancing queue");
      this.playNext().catch((err) => {
        this.logger.error({ err }, "playNext failed after trackEnd");
      });
    });

    this.player.on("error", (err: Error) => {
      this.logger.error({ err }, "Player error");
      this.playNext().catch((err2) => {
        this.logger.error({ err: err2 }, "playNext failed after player error");
      });
    });
  }

  private setupTsEvents(): void {
    this.tsClient.on("textMessage", (msg: TS3TextMessage) => {
      this.handleTextMessage(msg).catch((err) => {
        this.logger.error({ err }, "Unhandled error in text message handler");
      });
    });

    this.tsClient.on("disconnected", () => {
      // Always reset local state — covers the case where connect() never
      // completed (hanging handshake → 60s library idle timeout) and
      // this.connected was never flipped to true. Previously this handler
      // short-circuited on !this.connected, leaving player stuck as "playing".
      this.connected = false;
      this.player.stop();
      // Only emit externally once per lifecycle so clients don't see a
      // duplicate "disconnected" after an explicit disconnect() call.
      if (this.disconnectEmitted) return;
      this.disconnectEmitted = true;
      this.emit("disconnected");
    });

    this.tsClient.on("connected", () => {
      this._startIdlePoller();
    });
  }

  async connect(): Promise<void> {
    this.disconnectEmitted = false;
    await this.tsClient.connect();
    // Race guard: if disconnect() was called while the handshake was
    // awaiting, don't flip connected back to true — that would leave the
    // bot in an inconsistent state (externally "connected" but the tsClient
    // has already been torn down).
    if (this.disconnectEmitted) {
      throw new Error("Connect aborted by concurrent disconnect");
    }
    this.connected = true;
    this.profileManager.onConnect();
    this.emit("connected");
  }

  disconnect(): void {
    this._cancelIdleTimer();
    this.player.stop();
    this.connected = false;
    if (!this.disconnectEmitted) {
      this.disconnectEmitted = true;
      this.emit("disconnected");
    }
    this.tsClient.disconnect();
  }

  /** 外部更新 idleTimeoutMinutes（由 API 保存时调用） */
  updateIdleTimeout(minutes: number): void {
    this.config.idleTimeoutMinutes = minutes;
    if (minutes === 0) this._cancelIdleTimer();
  }

  private _startIdlePoller(): void {
    // 每 30 秒检查一次频道人数
    const poll = async () => {
      if (!this.connected) return;
      try {
        const clients = await this.tsClient.getClientsInChannel();
        const userCount = clients.length - 1; // 排除 bot 自身
        if (userCount <= 0) {
          this._scheduleIdleCheck();
        } else {
          this._cancelIdleTimer();
        }
      } catch { /* ignore */ }
      setTimeout(poll, 30_000);
    };
    setTimeout(poll, 30_000);
  }

  private _scheduleIdleCheck(): void {
    if (this.idleTimer !== null) return; // 已经在倒计时，不重复创建
    const minutes = this.config.idleTimeoutMinutes ?? 0;
    if (!this.connected || minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (!this.connected) return;
      this.logger.info({ idleMinutes: minutes }, "Channel empty, disconnecting due to idle timeout");
      this.disconnect();
    }, minutes * 60 * 1000);
  }

  private _cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async handleTextMessage(msg: TS3TextMessage): Promise<void> {
    const parsed = parseCommand(
      msg.message,
      this.config.commandPrefix,
      this.config.commandAliases
    );
    if (!parsed) return;

    if (isAdminCommand(parsed.name)) {
      // TODO: Check if invoker is in adminGroups
    }

    this.logger.info(
      { command: parsed.name, args: parsed.args, invoker: msg.invokerName },
      "Command received"
    );

    try {
      const response = await this.executeCommand(parsed, msg);
      if (response) {
        await this.tsClient.sendTextMessage(response);
      }
    } catch (err) {
      this.logger.error({ err, command: parsed.name }, "Command execution error");
      try {
        await this.tsClient.sendTextMessage(
          `Error: ${(err as Error).message}`
        );
      } catch (sendErr) {
        this.logger.error({ err: sendErr }, "Failed to send error message to chat");
      }
    }
  }

  async executeCommand(
    cmd: ParsedCommand,
    msg?: TS3TextMessage
  ): Promise<string | null> {
    // Reject commands that would push audio when the bot isn't connected:
    // otherwise ffmpeg spawns and voice goes to a half-initialized or
    // torn-down TS client, leaving player.state="playing" on a disconnected
    // bot. Config-only commands (vol, mode, clear, stop, queue, now) are
    // still allowed so the UI stays usable while the bot is offline.
    const AUDIO_COMMANDS = new Set([
      "play",
      "add",
      "playnext",
      "pn",
      "next",
      "skip",
      "prev",
      "playlist",
      "album",
      "fm",
      "artist",
    ]);
    if (!this.connected && AUDIO_COMMANDS.has(cmd.name)) {
      throw new Error("Bot is not connected to TeamSpeak");
    }
    switch (cmd.name) {
      case "play":
        return this.cmdPlay(cmd);
      case "add":
        return this.cmdAdd(cmd);
      case "playnext":
      case "pn":
        return this.cmdPlayNext(cmd);
      case "pause":
        return this.cmdPause();
      case "resume":
        return this.cmdResume();
      case "stop":
        return this.cmdStop();
      case "next":
      case "skip":
        return this.cmdNext();
      case "prev":
        return this.cmdPrev();
      case "vol":
        return this.cmdVol(cmd);
      case "now":
        return this.cmdNow();
      case "queue":
      case "list":
        return this.cmdQueue();
      case "clear":
        return this.cmdClear();
      case "remove":
        return this.cmdRemove(cmd);
      case "mode":
        return this.cmdMode(cmd);
      case "playlist":
        return this.cmdPlaylist(cmd);
      case "album":
        return this.cmdAlbum(cmd);
      case "fm":
        return this.cmdFm();
      case "artist":
        return this.cmdArtist(cmd);
      case "vote":
        return this.cmdVote(msg);
      case "lyrics":
        return this.cmdLyrics();
      case "move":
        return this.cmdMove(cmd);
      case "follow":
        return this.cmdFollow(msg);
      case "help":
        return this.cmdHelp();
      default:
        return `Unknown command: ${cmd.name}. Type ${this.config.commandPrefix}help for help.`;
    }
  }

  getProviderFor(platform: "netease" | "qq" | "bilibili" | "youtube"): MusicProvider {
    if (platform === "bilibili") return this.bilibiliProvider;
    if (platform === "youtube") return this.youtubeProvider;
    return platform === "qq" ? this.qqProvider : this.neteaseProvider;
  }

  private getProvider(flags: Set<string>): MusicProvider {
    if (flags.has("b")) return this.bilibiliProvider;
    if (flags.has("q")) return this.qqProvider;
    if (flags.has("y")) return this.youtubeProvider;
    return this.neteaseProvider;
  }

  /** Resolve URL for a song and start playing it. Skips to next if URL fails. */
  async resolveAndPlay(song: QueuedSong): Promise<boolean> {
    if (!this.connected) {
      this.logger.warn({ songId: song.id, name: song.name }, "resolveAndPlay called on disconnected bot — skipping");
      return false;
    }
    // Clear any accumulated skip votes — every fresh track starts with a
    // clean slate, regardless of which code path loaded it (cmdPlay,
    // cmdPlaylist, cmdAlbum, cmdFm, trackEnd auto-advance, etc.).
    this.voteSkipUsers.clear();
    const provider = this.getProviderFor(song.platform);
    try {
      const url = await provider.getSongUrl(song.id);
      if (!url) {
        this.logger.warn({ songId: song.id, name: song.name }, "No URL available, skipping");
        return false;
      }
      // Re-check connection state AFTER the network round-trip — the URL
      // resolve can take multiple seconds and the user may have called stop
      // during that window. Without this, we'd spawn ffmpeg on a
      // disconnected bot and land back in the same "connected=false but
      // playing=true" inconsistency that Bug C was about.
      if (!this.connected) {
        this.logger.warn(
          { songId: song.id, name: song.name },
          "bot disconnected during URL resolve — aborting playback",
        );
        return false;
      }
      song.url = url;
      this.player.play(url);
      this.database.addPlayHistory({
        botId: this.id,
        songId: song.id,
        songName: song.name,
        artist: song.artist,
        album: song.album,
        platform: song.platform,
        coverUrl: song.coverUrl,
      });
      // Update bot presence (fire-and-forget — never blocks playback)
      this.profileManager.onSongChange(song).catch((err) => {
        this.logger.warn({ err }, "Profile update failed after song change");
      });
      this.emit("stateChange");
      return true;
    } catch (err) {
      this.logger.error({ err, songId: song.id }, "Failed to resolve URL");
      return false;
    }
  }

  private async cmdPlay(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !play <song name or URL>";
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 1);
    if (result.songs.length === 0)
      return `No results found for: ${cmd.args}`;

    const song = result.songs[0];
    this.queue.clear();
    this.isFmMode = false;
    this.queue.add({ ...song, platform: provider.platform });
    this.queue.play();

    // Reset failure counter on user-initiated play
    this.player.resetFailures();
    const ok = await this.resolveAndPlay(this.queue.current()!);
    if (!ok) return `Cannot play: ${song.name}`;
    return `Now playing: ${song.name} - ${song.artist}`;
  }

  private async cmdAdd(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !add <song name>";
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 1);
    if (result.songs.length === 0)
      return `No results found for: ${cmd.args}`;

    const song = result.songs[0];
    const wasIdle = this.player.getState() === "idle";
    this.queue.add({ ...song, platform: provider.platform });

    // If nothing was playing, start this newly-added song immediately.
    // Matches /api/player/:id/add-by-id behavior so both add paths feel
    // the same to the user (add to idle bot → plays now).
    if (wasIdle) {
      this.queue.playAt(this.queue.size() - 1);
      this.player.resetFailures();
      await this.resolveAndPlay(this.queue.current()!);
      this.emit("stateChange");
      return `Now playing: ${song.name} - ${song.artist}`;
    }

    this.emit("stateChange");
    return `Added to queue: ${song.name} - ${song.artist} (position ${this.queue.size()})`;
  }

  private async cmdPlayNext(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !playnext <song name>";
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 1);
    if (result.songs.length === 0)
      return `No results found for: ${cmd.args}`;

    const song = result.songs[0];
    const wasIdle = this.player.getState() === "idle";
    // Capture the slot addNext WILL insert at, before mutating the queue.
    // addNext pushes when currentIndex<0 (slot = size); otherwise splices
    // at currentIndex+1. Using size-1 after addNext was wrong when the
    // queue had stale currentIndex>=0 while the player was idle (e.g.,
    // after natural track end without queue.clear()).
    const insertedAt =
      this.queue.getCurrentIndex() < 0
        ? this.queue.size()
        : this.queue.getCurrentIndex() + 1;
    this.queue.addNext({ ...song, platform: provider.platform });

    if (wasIdle) {
      this.queue.playAt(insertedAt);
      this.player.resetFailures();
      const ok = await this.resolveAndPlay(this.queue.current()!);
      this.emit("stateChange");
      if (!ok) return `Cannot play: ${song.name}`;
      return `Now playing: ${song.name} - ${song.artist}`;
    }

    this.emit("stateChange");
    return `Up next: ${song.name} - ${song.artist}`;
  }

  private cmdPause(): string {
    this.player.pause();
    this.emit("stateChange");
    return "Paused";
  }

  private cmdResume(): string {
    this.player.resume();
    this.emit("stateChange");
    return "Resumed";
  }

  private cmdStop(): string {
    this.player.stop();
    this.queue.clear();
    this.isFmMode = false;
    this.profileManager.onSongChange(null).catch((err) => {
      this.logger.warn({ err }, "Profile restore failed on stop");
    });
    this.emit("stateChange");
    return "Stopped and queue cleared";
  }

  private async cmdNext(): Promise<string> {
    await this.playNext();
    const current = this.queue.current();
    if (current)
      return `Now playing: ${current.name} - ${current.artist}`;
    return "Queue is empty";
  }

  private async cmdPrev(): Promise<string> {
    // Retry-skip up to 4 attempts: history can include failed songs
    // that playNext's auto-advance retry-skipped past, so a single
    // prev would otherwise land on an unplayable song and leave the
    // queue's currentIndex stuck mid-failure.
    for (let i = 0; i < 4; i++) {
      const prev = this.queue.prev();
      if (!prev) return "No previous song";
      const ok = await this.resolveAndPlay(prev);
      if (ok) return `Now playing: ${prev.name} - ${prev.artist}`;
    }
    return "Cannot play any previous songs (all failed to resolve)";
  }

  private cmdVol(cmd: ParsedCommand): string {
    const vol = parseInt(cmd.args, 10);
    if (isNaN(vol) || vol < 0 || vol > 100) return "Usage: !vol <0-100>";
    this.player.setVolume(vol);
    this.emit("stateChange");
    return `Volume set to ${vol}%`;
  }

  private cmdNow(): string {
    const song = this.queue.current();
    if (!song) return "Nothing is playing";
    return `Now playing: ${song.name} - ${song.artist} [${song.album}] (${song.platform})`;
  }

  private cmdQueue(): string {
    const songs = this.queue.list();
    if (songs.length === 0) return "Queue is empty";
    const currentIdx = this.queue.getCurrentIndex();
    const lines = songs.map((s, i) => {
      const marker = i === currentIdx ? "▶ " : "  ";
      return `${marker}${i + 1}. ${s.name} - ${s.artist}`;
    });
    return `Queue (${songs.length} songs, mode: ${this.queue.getMode()}):\n${lines.join("\n")}`;
  }

  private cmdClear(): string {
    this.player.stop();
    this.queue.clear();
    this.isFmMode = false;
    this.profileManager.onSongChange(null).catch((err) => {
      this.logger.warn({ err }, "Profile restore failed on clear");
    });
    this.emit("stateChange");
    return "Queue cleared";
  }

  private cmdRemove(cmd: ParsedCommand): string {
    const index = parseInt(cmd.args, 10) - 1;
    if (isNaN(index) || index < 0) return "Usage: !remove <number>";
    const removed = this.queue.remove(index);
    if (!removed) return "Invalid position";
    this.emit("stateChange");
    return `Removed: ${removed.name}`;
  }

  private cmdMode(cmd: ParsedCommand): string {
    const modeMap: Record<string, PlayMode> = {
      seq: PlayMode.Sequential,
      loop: PlayMode.Loop,
      random: PlayMode.Random,
      rloop: PlayMode.RandomLoop,
    };
    const mode = modeMap[cmd.args];
    if (mode === undefined) return "Usage: !mode <seq|loop|random|rloop>";
    this.queue.setMode(mode);
    this.emit("stateChange");
    return `Play mode set to: ${cmd.args}`;
  }

  private async cmdPlaylist(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !playlist <playlist name or ID>";
    const provider = this.getProvider(cmd.flags);

    // Determine if input is a numeric ID or a name search
    const id = this.extractId(cmd.args);
    const isNumericId = /^\d+$/.test(cmd.args.trim());

    let playlistId: string;

    if (isNumericId || id !== cmd.args) {
      // Input is a numeric ID or URL containing an ID — use existing logic
      playlistId = id;
    } else {
      // Name-based search
      const result = await provider.search(cmd.args);
      let playlists = result.playlists ?? [];

      // Also search user's personal playlists if logged in
      if (provider.getUserPlaylists) {
        try {
          const userPlaylists = await provider.getUserPlaylists();
          const query = cmd.args.toLowerCase();
          const matched = userPlaylists.filter(
            p => p.name.toLowerCase().includes(query)
          );
          // Merge: public results first (API-ranked), then user matches
          playlists = [...playlists, ...matched];
        } catch {
          // User playlists unavailable — continue with public results
        }
      }

      if (playlists.length === 0)
        return `No playlists found for: ${cmd.args}`;
      playlistId = playlists[0].id;
    }

    const songs = await provider.getPlaylistSongs(playlistId);
    if (songs.length === 0) return "Playlist is empty or not found";

    this.queue.clear();
    this.isFmMode = false;
    for (const song of songs) {
      this.queue.add({ ...song, platform: provider.platform });
    }
    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdAlbum(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !album <album ID>";
    const provider = this.getProvider(cmd.flags);
    const songs = await provider.getAlbumSongs(cmd.args);
    if (songs.length === 0) return "Album is empty or not found";

    this.queue.clear();
    this.isFmMode = false;
    for (const song of songs) {
      this.queue.add({ ...song, platform: provider.platform });
    }
    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdFm(): Promise<string> {
    if (!this.neteaseProvider.getPersonalFm) {
      return "Personal FM is only available for NetEase Cloud Music";
    }
    const songs = await this.neteaseProvider.getPersonalFm();
    if (songs.length === 0)
      return "No FM songs available (need to login first)";

    this.queue.clear();
    for (const song of songs) {
      this.queue.add({ ...song, platform: "netease" });
    }
    this.queue.setMode(PlayMode.Random);
    this.isFmMode = true;
    this.player.resetFailures();

    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Personal FM started: ${first?.name ?? "unknown"} - ${first?.artist ?? ""}`;
  }

  private async cmdArtist(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !artist <artist name>";
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 50);
    if (result.songs.length === 0)
      return `No results found for artist: ${cmd.args}`;

    const query = cmd.args.toLowerCase();
    let filtered = result.songs.filter(
      s => s.artist.toLowerCase().includes(query)
    );

    // Fallback to unfiltered results if filtering drops everything
    if (filtered.length === 0) {
      filtered = result.songs.slice(0, 20);
    }

    this.queue.clear();
    this.isFmMode = false;
    for (const song of filtered) {
      this.queue.add({ ...song, platform: provider.platform });
    }
    this.queue.setMode(PlayMode.Loop);
    this.player.resetFailures();

    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Artist mode: ${cmd.args} — ${filtered.length} songs loaded. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async refillFm(): Promise<void> {
    if (!this.isFmMode || !this.neteaseProvider.getPersonalFm) return;
    try {
      const songs = await this.neteaseProvider.getPersonalFm();
      if (songs.length === 0) return;
      for (const song of songs) {
        this.queue.add({ ...song, platform: "netease" });
      }
      this.logger.debug({ count: songs.length }, "FM queue refilled");
    } catch (err) {
      this.logger.error({ err }, "Failed to refill FM queue");
    }
  }

  private async cmdVote(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Vote can only be used in TeamSpeak";
    this.voteSkipUsers.add(msg.invokerUid);
    const clients = await this.tsClient.getClientsInChannel();
    const totalUsers = clients.length - 1; // exclude the bot itself
    // At least 1 vote is always required — otherwise a single voter in an
    // otherwise empty channel (or a transient clients.length=1 race) could
    // unanimously "win" with needed=0.
    const needed = Math.max(1, Math.ceil(totalUsers / 2));
    const votes = this.voteSkipUsers.size;

    if (votes >= needed) {
      this.voteSkipUsers.clear();
      this.playNext().catch((err) => {
        this.logger.error({ err }, "playNext failed after vote skip");
      });
      return `Vote passed (${votes}/${needed}). Skipping to next song.`;
    }
    return `Vote to skip: ${votes}/${needed} (need ${needed - votes} more)`;
  }

  private async cmdLyrics(): Promise<string> {
    const song = this.queue.current();
    if (!song) return "Nothing is playing";
    const provider = this.getProviderFor(song.platform);
    const lyrics = await provider.getLyrics(song.id);
    if (lyrics.length === 0) return "No lyrics available";
    const lines = lyrics.slice(0, 10).map((l) => l.text);
    return `Lyrics for ${song.name}:\n${lines.join("\n")}`;
  }

  private async cmdMove(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !move <channel name or ID>";
    await this.tsClient.joinChannel(cmd.args);
    return `Moved to channel: ${cmd.args}`;
  }

  private async cmdFollow(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Follow can only be used in TeamSpeak";
    return "Following you to your channel";
  }

  private cmdHelp(): string {
    const p = this.config.commandPrefix;
    return [
      "TSMusicBot Commands:",
      `${p}play <song>  — Search and play`,
      `${p}play -q <song> — Search from QQ Music`,
      `${p}play -b <song> — Search from BiliBili`,
      `${p}play -y <song> — Search from YouTube (yt-dlp)`,
      `${p}add <song>   — Add to queue`,
      `${p}playnext <song> — Insert as next song (alias: ${p}pn)`,
      `${p}pause/resume — Pause/resume`,
      `${p}next/prev    — Next/previous`,
      `${p}stop         — Stop and clear queue`,
      `${p}vol <0-100>  — Set volume`,
      `${p}queue        — Show queue`,
      `${p}mode <seq|loop|random|rloop> — Play mode`,
      `${p}playlist <name or id> — Load playlist by name or ID`,
      `${p}playlist -q <name or id> — Load playlist from QQ Music`,
      `${p}album <id>   — Load album`,
      `${p}fm           — Personal FM (NetEase)`,
      `${p}artist <name> — Play songs by artist (loop)`,
      `${p}artist -q <name> — Artist loop from QQ Music`,
      `${p}vote         — Vote to skip`,
      `${p}lyrics       — Show lyrics`,
      `${p}now          — Current song info`,
      `${p}help         — This help message`,
    ].join("\n");
  }

  /**
   * Advance the queue and play the next song. If the resolved URL fails
   * (e.g., copyright/region restrictions for QQ), skips up to `maxRetries`
   * more songs looking for a playable one. Public so REST endpoints that
   * seed the queue can fall back to this retry-skip behavior.
   *
   * Returns true if a song actually started playing, false otherwise.
   */
  async playNext(maxRetries = 3): Promise<boolean> {
    if (this.isAdvancing || !this.connected) return false;
    this.isAdvancing = true;
    try {
      this.voteSkipUsers.clear();
      const next = this.queue.next();
      let started = false;
      if (next) {
        started = await this.resolveAndPlay(next);
        if (!started) {
          for (let i = 0; i < maxRetries && this.connected; i++) {
            const retry = this.queue.next();
            if (!retry) break;
            if (await this.resolveAndPlay(retry)) {
              started = true;
              break;
            }
          }
        }
        if (!started) {
          this.player.stop();
          this.profileManager.onSongChange(null).catch(() => {});
        } else if (this.isFmMode && this.queue.unplayedCount() <= 3) {
          // Proactive refill: when queue is running low, fetch more FM songs
          this.refillFm().catch(err => this.logger.error({ err }, "Proactive FM refill failed"));
        }
      } else {
        // Queue exhausted — in FM Random mode, refill and continue
        if (this.isFmMode) {
          await this.refillFm();
          const refillNext = this.queue.next();
          if (refillNext) {
            started = await this.resolveAndPlay(refillNext);
          }
          if (!started) {
            this.player.stop();
            this.profileManager.onSongChange(null).catch(() => {});
          }
        } else {
          this.player.stop();
          this.profileManager.onSongChange(null).catch(() => {});
        }
      }
      this.emit("stateChange");
      return started;
    } finally {
      this.isAdvancing = false;
    }
  }

  private extractId(input: string): string {
    const match = input.match(/[?&]id=(\d+)/);
    if (match) return match[1];
    const pathMatch = input.match(/\/(\d+)/);
    if (pathMatch) return pathMatch[1];
    return input;
  }

  getStatus(): BotStatus {
    return {
      id: this.id,
      name: this.name,
      connected: this.connected,
      playing: this.player.getState() === "playing",
      paused: this.player.getState() === "paused",
      currentSong: this.queue.current(),
      queueSize: this.queue.size(),
      volume: this.player.getVolume(),
      playMode: this.queue.getMode(),
      elapsed: this.player.getElapsed(),
    };
  }

  getQueue(): QueuedSong[] {
    return this.queue.list();
  }

  getPlayer(): AudioPlayer {
    return this.player;
  }

  getQueueManager(): PlayQueue {
    return this.queue;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getProfileManager(): BotProfileManager {
    return this.profileManager;
  }

  getIdentityExport(): string | undefined {
    return this.tsClient.getIdentityExport();
  }
}
