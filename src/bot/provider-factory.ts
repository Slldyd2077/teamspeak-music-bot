import type { MusicProvider } from "../music/provider.js";
import type { Logger } from "../logger.js";
import { NeteaseProvider } from "../music/netease.js";
import { QQMusicProvider } from "../music/qq.js";
import { BiliBiliProvider } from "../music/bilibili.js";
import { KugouProvider } from "../music/kugou.js";
import { LocalMusicProvider } from "../music/local.js";
import { YouTubeProvider } from "../music/youtube.js";
import { JellyfinProvider } from "../music/jellyfin.js";
import { SpotifyProvider } from "../music/spotify/provider.js";

/**
 * Constructs per-bot music providers.
 *
 * Cookie-bearing platforms (netease / qq / bilibili / kugou / jellyfin) get a
 * FRESH instance per bot so each bot holds its own platform login. The
 * cookie-less platforms (local audio, youtube) are shared singletons — local
 * because its file-cleanup coordination is cross-bot, youtube because it is
 * auth-less. Spotify metadata is also a shared singleton: its credentials are
 * the admin's global client id/secret (playback goes through the per-bot
 * SpotifyController, not the provider).
 *
 * BotManager calls `createX()` once per bot, then applies that bot's saved
 * cookie via `setCookie(...)`.
 */
export interface ProviderFactory {
  createNetease(): MusicProvider;
  createQQ(): MusicProvider;
  createBiliBili(): MusicProvider;
  createKugou(): MusicProvider;
  /** Per-bot instance; credentials + token blob come from the bot's cookie slot. */
  createJellyfin(logger?: Logger): MusicProvider;
  /** Shared singleton (cookie-less; cross-bot file cleanup). */
  readonly localProvider: MusicProvider;
  /** Shared singleton (auth-less; uses yt-dlp). */
  readonly youtubeProvider: MusicProvider;
  /** Shared singleton (global admin client credentials via setCreds). */
  readonly spotifyProvider: MusicProvider;
}

export function createProviderFactory(opts: {
  neteaseBaseUrl: string;
  qqMusicBaseUrl: string;
  localAudioDir: string;
}): ProviderFactory {
  const localProvider: MusicProvider = new LocalMusicProvider(opts.localAudioDir);
  const youtubeProvider: MusicProvider = new YouTubeProvider();
  const spotifyProvider: MusicProvider = new SpotifyProvider();

  return {
    createNetease: () => new NeteaseProvider(opts.neteaseBaseUrl),
    createQQ: () => new QQMusicProvider(opts.qqMusicBaseUrl),
    createBiliBili: () => new BiliBiliProvider(),
    createKugou: () => new KugouProvider(),
    createJellyfin: (logger?: Logger) => new JellyfinProvider(logger),
    localProvider,
    youtubeProvider,
    spotifyProvider,
  };
}
