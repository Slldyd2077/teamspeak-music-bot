# Spotify audio source (optional, hybrid librespot) — design spec

- **Issue:** [#112 — Support for Spotify audio source](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot/issues/112)
- **Date:** 2026-07-01
- **Status:** Approved (design) — pending implementation plan
- **Chosen approach:** Hybrid — real Spotify streaming via a librespot-family sidecar, with **go-librespot on Linux/Docker** and **Rust librespot on Windows**, behind one backend interface.

---

## 1. Summary

Add `spotify` as a new **optional** `MusicProvider`. Metadata (search / track / album / playlist) is read from the official **Spotify Web API**. Audio is the *real* Spotify stream, produced by a librespot-family sidecar and piped through ffmpeg into the bot's existing voice path.

The feature is **disabled by default**, opt-in, and **requires the user's own Spotify Premium account**. librespot is an unofficial, reverse-engineered client and using it **violates Spotify's Terms of Service** (account-ban risk). This is surfaced to the user as an explicit experimental warning, and no credentials are ever bundled.

If the feature is disabled, unauthenticated, or the sidecar binary is missing, the provider disables itself gracefully — exactly like `YouTubeProvider` when `yt-dlp` is absent (empty results, greyed-out in the UI, no crash).

## 2. Goals / Non-goals

**Goals**
- First-class `spotify` source: search, play, playlist/album import, lyrics best-effort, login status.
- Real Spotify audio (Premium), not a YouTube match.
- Cross-platform: works on the project's three deployments — native Windows one-click, Linux systemd, Docker.
- Strictly optional and safe-by-default; zero impact when off.
- Mixed queues keep working (Spotify tracks interleaved with netease/qq/etc.).

**Non-goals**
- No free-tier audio (Premium is mandatory for librespot streaming).
- No bundled Spotify credentials or shared Developer app.
- No replacement of, or change to, existing sources' behavior.
- No CI e2e against live Spotify (requires Premium; manual only).

## 3. Backend selection

`spotify.backend: "auto" | "go-librespot" | "librespot"` (default `auto`).

| Platform | `auto` resolves to | Why |
|---|---|---|
| Windows | `librespot` (Rust) | go-librespot has **no** Windows binary and its FIFO capture is POSIX-only |
| Linux / Docker | `go-librespot` (fallback `librespot`) | clean REST play-by-URI + prebuilt Linux binary |
| macOS | `librespot` (or `go-librespot` if built) | no go-librespot macOS binary published |

The split is **platform-determined**, not a per-run user toggle (a user may still force one via config if they have the binary).

## 4. Architecture

### 4.1 The seam — `SpotifyAudioBackend`

New file `src/music/spotify/backend.ts`:

```ts
export interface SpotifyTrackEndedEvent { uri: string; reason: "ended" | "stopped" | "error"; }

export interface SpotifyAudioBackend {
  start(): Promise<void>;                    // launch sidecar + resampling ffmpeg
  stop(): void;                              // tear everything down
  isReady(): boolean;                        // device online & streamable
  playTrack(uri: string): Promise<void>;     // begin ONE track (spotify:track:...)
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  getPcmStream(): Readable;                   // 48kHz s16le stereo (post-ffmpeg)
  getPosition(): number;                      // ms into current track
  on(event: "trackEnded", cb: (e: SpotifyTrackEndedEvent) => void): void;
  on(event: "metadata", cb: (m: SpotifyNowPlaying) => void): void;
  on(event: "ready" | "error", cb: (arg?: unknown) => void): void;
}
```

Both implementations emit the **same** 48 kHz s16le stereo PCM and the **same** events, so everything above the seam (provider, controller, player, UI) is backend-agnostic.

### 4.2 `GoLibrespotBackend` (Linux/Docker) — `src/music/spotify/go-librespot.ts`

- Writes a `config.yml` with `server: { enabled: true, address: 'localhost', port: <p> }`, `audio_backend: 'pipe'`, `audio_output_pipe: '<fifo>'`, `audio_output_pipe_format: 's16le'`, `bitrate: 320`, credentials block.
- `start()`: `mkfifo <fifo>` → **spawn the FIFO-reading ffmpeg first** → then spawn go-librespot. (FIFO open ordering is mandatory: go-librespot opens the write end with `O_WRONLY|O_NONBLOCK` and errors `ENXIO` if no reader exists yet.) ffmpeg: `-f s16le -ar 44100 -ac 2 -i <fifo> -f s16le -ar 48000 -ac 2 -`. ffmpeg stdout = `getPcmStream()`.
- Control (REST): `POST /player/play {uri}`, `POST /player/pause`, `POST /player/resume`, `POST /player/seek {position}`. `GET /status` for position.
- Events (WebSocket `/events`): `metadata` → `metadata`; `not_playing` → `trackEnded` (track boundaries can NOT be read from the FIFO — it is gapless/continuous and never EOFs between tracks).
- Metadata token: go-librespot exposes `POST /token` (first-party session token) and a `/web-api/<path>` proxy to `api.spotify.com` — so on this backend a separate Spotify Developer app is **optional**.
- Recovery: on reader death go-librespot's write returns `EPIPE` and closes the pipe output; backend restarts the ffmpeg reader + reactivates the device.

### 4.3 `RustLibrespotBackend` (Windows / cross-platform) — `src/music/spotify/rust-librespot.ts`

Rust librespot is a **passive Spotify Connect receiver**; the bot acts as the **Connect controller** via the Spotify Web API.

- `start()`: spawn `librespot --backend pipe --name "<deviceName>" --bitrate 320 --cache <dir> [--access-token <tok> | --enable-oauth]`. With **no `--device`**, librespot writes raw PCM (**s16le, 44100 Hz, stereo**) to **stdout** (cross-platform; verified against `pipe.rs` — `None => Box::new(io::stdout())`). Pipe stdout → ffmpeg `-f s16le -ar 44100 -ac 2 -i pipe:0 -f s16le -ar 48000 -ac 2 -` → `getPcmStream()`. Do **not** pass `--passthrough` (that emits raw Ogg, not PCM).
- `playTrack(uri)`: `GET /v1/me/player/devices` → find our `device_id` by `deviceName` → `PUT /v1/me/player/play?device_id={id}` body `{uris:[uri]}`. `pause/resume/seek` → `PUT /v1/me/player/{pause,play,seek}`.
- `trackEnded`: poll `GET /v1/me/player` (is_playing → false / `item` changed / `progress_ms ≈ duration_ms`) plus optional `--onevent` hook (read-only notifications). Add a watchdog + retry/backoff for device-visibility latency and command `202/404` flakiness.
- Requires a **user OAuth token** with scopes `streaming user-read-playback-state user-modify-playback-state user-read-currently-playing` (+ `playlist-read-private playlist-read-collaborative` for user playlists).

## 5. Shared subsystems

### 5.1 Metadata — `src/music/spotify/webapi.ts`

Thin `axios` client mapping Spotify catalog objects → the bot's `Song` / `Playlist` / `Album`:
- `GET /v1/search?type=track,album,playlist&q=…`
- `GET /v1/tracks/{id}`, `GET /v1/albums/{id}/tracks`, `GET /v1/playlists/{id}/tracks`

All confirmed still available with a normal token **after** Spotify's 2024-11-27 cut (that cut removed related-artists, recommendations, audio-features/analysis, featured/category playlists, and `preview_url` — none of which we use). Token source is pluggable: user Developer-app token (primary) or go-librespot `/web-api` proxy (go-librespot path). Handle `429 Retry-After` (rolling 30 s window; dev-mode quota).

### 5.2 Auth — `src/music/spotify/auth.ts`

One web-UI **Authorization-Code + PKCE** login.
- **Primary:** the user registers their own Spotify Developer app (Client ID [+ Secret] + redirect URI) — reliable, ToS-cleaner. The resulting access token drives metadata + Web-API control; the refresh token is persisted (credential store); access tokens (~1 h) auto-refresh. The same token bootstraps librespot via `--access-token`, after which librespot caches reusable credentials — **one user-facing login**.
- **Fallbacks:** librespot `--enable-oauth` (built-in client `65b708073fc0480ea92a077233ca87bd`, redirect `http://127.0.0.1:8898/login`) or go-librespot interactive login (`http://127.0.0.1:36842/login?code=…`) as a separate one-time step; go-librespot `/web-api` proxy when no Developer app is provided.
- Username/password is **dead** (removed by Spotify in 2024); do not implement it.

### 5.3 Provider — `src/music/spotify/provider.ts`

`SpotifyProvider implements MusicProvider` with `platform: "spotify"`:
- `search`, `getSongDetail`, `getPlaylistSongs`, `getAlbumSongs`, `getLyrics` (best-effort/empty), `getRecommendPlaylists` → Web API.
- `getAuthStatus()` reports login state **and** backend/binary availability (drives greying-out in UI, like YouTube).
- `getSongUrl(id)` returns a **sentinel** (`{ url: "spotify:track:<id>" }`) — actual playback is via the backend/controller, not a URL. `instance.ts` recognizes the sentinel and routes to the `SpotifyController`.
- QR-code login methods are no-ops; Spotify uses the OAuth card instead.

## 6. Queue / player / instance integration

- **`SpotifyController`** (`src/music/spotify/controller.ts`, one per bot): owns the chosen backend and the Web-API/auth clients; exposes `playTrack/pause/resume/seek/stop` and forwards `trackEnded`/`metadata`.
- **`AudioPlayer` — new external-PCM mode:** add `playPcmStream(readable, { onExternalEnd })` that feeds the existing `pcmBuffer` → 20 ms frame loop → encoder → `frame` path **without spawning a url-ffmpeg**. For Spotify, `trackEnd` is driven by the backend's `trackEnded` event (the librespot→ffmpeg pipeline is long-lived and does not exit per song). `pause/resume/seek` on a Spotify song are routed to the backend by `instance.ts` (and gate frame emission locally for crisp UI state).
- **`instance.ts`:** `getProviderFor("spotify")`, a `-s` command flag in `getProvider(flags)`. When a dequeued `song.platform === "spotify"`: ensure the controller/backend is started + device active, `playTrack(uri)`, attach the player to the backend PCM. On `trackEnded` → advance the queue. When a **non-Spotify** song is next, **pause the sidecar** (so it doesn't buffer ahead) and use the normal `player.play(url)` path. This preserves one-track-at-a-time on-demand playback and mixed-source queues.
- Real-time pacing is guaranteed by the voice consumer: TS voice pulls 20 ms frames at real time → the player reads PCM at real time → ffmpeg's read of the sidecar stalls → sidecar backpressure pauses decode. (This is why go-librespot's pull model avoids the classic librespot "plays too fast / skips" bug; Rust librespot to stdout is likewise paced by our reads.)

## 7. Config, opt-in & safety

`BotConfig.spotify` (all default-off), added to `getDefaultConfig()` and sanitized in `loadConfig()`:

```ts
spotify: {
  enabled: false,
  backend: "auto",              // "auto" | "go-librespot" | "librespot"
  clientId: "",                 // user's Developer app (optional on go-librespot path)
  clientSecret: "",             // optional — PKCE needs none; only for confidential/client-credentials flows
  deviceName: "TSMusicBot",
  bitrate: 320,                 // 96 | 160 | 320
}
```

Inert unless `enabled` **and** logged-in **and** a resolvable binary. First-run/settings shows the experimental + ToS + Premium + own-credentials warning. Never store or transmit shared secrets.

## 8. Web UI

- Add `spotify` to `platform` and `Source` unions (`web/src/stores/player.ts`, `web/src/stores/sourceTabs.ts`).
- `SourceTabs.vue`: add "Spotify" tab; `SongCard.vue`: green **#1DB954** badge; `variables.scss`: `--brand-spotify` tokens.
- `stores/player.ts`: extend `authStatus` / `recommendPlaylists` / `dailySongs` / `userPlaylists` maps + the auth/recommend fetch fan-out.
- Settings: a **Spotify login card distinct from the QR cards** — "Connect Spotify" OAuth button, optional Client ID/Secret fields, backend/binary status indicator, and the risk disclaimer.

## 9. Binary / dependency resolution — `src/music/spotify/binary.ts`

Mirror `findYtDlp()`: resolve `go-librespot` / `librespot(.exe)` from `bin/` then PATH; positive availability cached, negative retried (install-while-running).
- **No prebuilt Rust librespot exists** (source-only: `cargo install librespot`, distro/`scoop`/`choco`, or a binary dropped in `bin/`).
- **go-librespot** ships **Linux-only** assets (`go-librespot_linux_{x86_64,arm64,armv6,armv6_rpi}.tar.gz`, ~6 MB, at `github.com/devgianlu/go-librespot/releases`). Docker build downloads the correct Linux asset; optional runtime auto-download (like yt-dlp). go-librespot is **GPL-3.0** → sidecar = mere aggregation (does not infect the Node code); ship its license text + a source offer.
- Unresolved binary → source disabled with an actionable "install X / see docs" message.

## 10. Testing

Vitest, mocking child processes and HTTP:
- Web-API response → `Song/Playlist/Album` mapping.
- `chooseBackend()` per platform/config.
- Auth: PKCE challenge, token refresh, credential persistence.
- Config load/sanitize (defaults, hand-edited/corrupt input).
- `SpotifyProvider` methods (mock webapi).
- Player external-PCM path: feed a fake `Readable` → assert `frame` emission + `trackEnd` on external end.
- go-librespot `/events` → `trackEnded` translation; Rust-backend Web-API poll → `trackEnded`.
- e2e against live Spotify is **manual & documented** (Premium required), not CI.

## 11. Files touched

**New:** `src/music/spotify/{provider,backend,go-librespot,rust-librespot,webapi,auth,controller,binary}.ts` (+ `.test.ts`).
**Edited (backend):** `src/music/provider.ts` (union: `Song`/`Playlist`/`Album`/`MusicProvider`), `src/index.ts`, `src/bot/manager.ts`, `src/bot/instance.ts` (router + `-s` flag + spotify routing), `src/audio/player.ts` (external-PCM mode), `src/data/config.ts`, `src/music/auth.ts` (credential store union), `src/web/api/auth.ts`, `src/web/api/music.ts` (routers + search aggregation), `src/web/server.ts`, `src/data/database.ts` (platform).
**Edited (frontend):** `web/src/stores/player.ts`, `web/src/stores/sourceTabs.ts`, `web/src/components/SourceTabs.vue`, `web/src/components/SongCard.vue`, `web/src/styles/variables.scss`.
**Docs:** `README.md` (Spotify section + warnings + install notes).

## 12. Staged rollout

1. **Metadata + provider + config + UI plumbing** (no audio): `spotify` source searchable/browsable; playback returns "not yet playable". Fully testable without a sidecar.
2. **go-librespot backend (Linux/Docker):** real playback on Linux; REST + FIFO + WebSocket.
3. **Rust librespot backend (Windows):** stdout PCM + Web-API Connect control.
4. **Polish:** recovery/watchdog, docs, binary auto-download, README.

## 13. Risks & open questions

- **Rust librespot control is the top risk** — Connect device visibility/latency, poll-based track-end. Mitigation: retry/backoff + watchdog; degrade to "skipped" on repeated failure.
- **One-OAuth-token bootstraps librespot** (`--access-token` from the user's own app client) is *plausible but unverified* — may fall back to two one-time logins. Verify with a spike in stage 3.
- **Windows go-librespot is impossible** (FIFO) → Windows always uses Rust librespot.
- **Token scope from librespot's built-in client** may not include `user-modify-playback-state`; if so, a user Developer app is required for the Rust/Windows control path.
- Large surface area → staged rollout above; each stage independently shippable.

## Appendix A — Verified technical facts (with sources)

go-librespot API (`devgianlu/go-librespot`, v0.7.x):
- REST: `POST /player/{play,pause,resume,playpause,stop,next,prev,seek,volume,add_to_queue}`, `GET /status`, `GET /` (`{playback_ready}`), `POST /token`, `GET|POST /web-api/<path>`. `POST /player/play` body `{uri, skip_to_uri?, paused?}`. Server enabled only when `server.enabled: true`.
- WebSocket `/events` envelopes `{type, data}`; types include `metadata, will_play, playing, paused, not_playing, stopped, seek, volume, active, inactive`. Track-end = `not_playing`.
- Pipe backend: continuous raw PCM, no header, 44100 Hz stereo, format `s16le|s32le|f32le`; FIFO opened once; POSIX-only. Backpressure real (blocks when reader stalls).
- Sources: `github.com/devgianlu/go-librespot` (README, `api-spec.yml`, `daemon/api_server.go`, `output/driver-pipe.go`).

Rust librespot (`librespot-org/librespot`, v0.8.0, MIT):
- `--backend pipe` with no `--device` → raw PCM to **stdout**; default S16 / 44100 / stereo; `--format` for higher bit depth; `--passthrough` = raw Ogg (do not use). Passive Connect receiver — no play-by-URI; control via Web API Connect. `--onevent` = read-only hook. No prebuilt binaries.
- Sources: `github.com/librespot-org/librespot` wiki (Audio-Backends, Options), `librespot_playback/audio_backend/pipe.rs`, `docs/authentication.md`.

Spotify auth & Web API:
- Username/password removed (2024); use OAuth (Auth-Code+PKCE) or Zeroconf. Premium required for librespot audio.
- Client-Credentials token authorizes `/v1/search` + public track/album/playlist GETs; 2024-11-27 cut did **not** touch these. Token endpoint `POST https://accounts.spotify.com/api/token` (`grant_type=client_credentials`, Basic base64(id:secret), `expires_in=3600`, no refresh). 429 on a rolling 30 s window.
- Sources: `developer.spotify.com` (Web API docs; 2024-11-27 blog), `librespot` `docs/authentication.md`.
