import type { MusicProvider } from "../music/provider.js";
import { NeteaseProvider } from "../music/netease.js";
import { QQMusicProvider } from "../music/qq.js";
import { BiliBiliProvider } from "../music/bilibili.js";
import { KugouProvider } from "../music/kugou.js";
import { LocalMusicProvider } from "../music/local.js";
import { YouTubeProvider } from "../music/youtube.js";

/**
 * Constructs per-bot music providers.
 *
 * Cookie-bearing platforms (netease / qq / bilibili / kugou) get a FRESH
 * instance per bot so each bot holds its own platform login cookie. The
 * cookie-less platforms (local audio, youtube) are shared singletons — local
 * because its file-cleanup coordination is cross-bot, youtube because it is
 * auth-less.
 *
 * BotManager calls `createX()` once per bot, then applies that bot's saved
 * cookie via `setCookie(...)`.
 */
export interface ProviderFactory {
  createNetease(): MusicProvider;
  createQQ(): MusicProvider;
  createBiliBili(): MusicProvider;
  createKugou(): MusicProvider;
  /** Shared singleton (cookie-less; cross-bot file cleanup). */
  readonly localProvider: MusicProvider;
  /** Shared singleton (auth-less; uses yt-dlp). */
  readonly youtubeProvider: MusicProvider;
}

export function createProviderFactory(opts: {
  neteaseBaseUrl: string;
  qqMusicBaseUrl: string;
  localAudioDir: string;
}): ProviderFactory {
  const localProvider: MusicProvider = new LocalMusicProvider(opts.localAudioDir);
  const youtubeProvider: MusicProvider = new YouTubeProvider();

  return {
    createNetease: () => new NeteaseProvider(opts.neteaseBaseUrl),
    createQQ: () => new QQMusicProvider(opts.qqMusicBaseUrl),
    createBiliBili: () => new BiliBiliProvider(),
    createKugou: () => new KugouProvider(),
    localProvider,
    youtubeProvider,
  };
}
