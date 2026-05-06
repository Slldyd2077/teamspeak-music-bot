# History-aware `prev` + "Play Next" Insert

**Date:** 2026-05-06
**Status:** Spec — pending implementation

## Problem

Two queue/playback gaps surfaced in real use:

1. In `PlayMode.Random` and `PlayMode.RandomLoop`, `!prev` does not play the
   actually-previously-played song. It just walks `currentIndex - 1` in the
   underlying array — but in random modes `currentIndex` jumps non-sequentially,
   so the "previous" array slot has no relationship to play history.

2. `!add` / web "添加到队列" appends to the queue tail. There is no way to
   say "play this song right after the current one." Users want a "下一首
   播放" affordance comparable to Spotify "Add to Queue (next up)" or Apple
   Music "Play Next".

## Goals

- `prev` walks back through the actual play history regardless of mode.
- A new "Play Next" path inserts a song at `currentIndex + 1`, available
  via web UI button and TS3 chat command.
- Both features are usable on desktop and mobile web.

## Out of Scope

- Forward/redo through prev'd songs (user would need to push next manually,
  which picks a fresh random in random modes — acceptable simplification).
- Reordering songs already in the queue ("move to next" inside Queue.vue).
- Persisting play history across bot restarts (in-memory only).

## Non-functional Constraints

- History capped at 50 entries to bound memory.
- `addNext` must keep `playedIndices` and `history` index references valid
  after insertion (shift all indices > current by +1).
- New Toast UX from the previous round still applies (failures surface).
- TypeScript and existing test suite must not regress.

## Architecture

### A. History-aware `prev`

**`src/audio/queue.ts`** — `PlayQueue` gains a back-stack:

```ts
private history: number[] = [];
private static readonly HISTORY_LIMIT = 50;

private pushHistory(idx: number): void {
  if (idx < 0) return;
  this.history.push(idx);
  if (this.history.length > PlayQueue.HISTORY_LIMIT) {
    this.history.shift();
  }
}
```

Mutators call `pushHistory(this.currentIndex)` **before** changing `currentIndex`:

| Method | History action |
|---|---|
| `play()` | `this.history = []` (fresh playback) |
| `playAt(idx)` | `pushHistory(currentIndex)`, then set `currentIndex = idx` |
| `next()` | `pushHistory(currentIndex)`, then advance per mode |
| `prev()` | **Pop** from history → `currentIndex = popped`. If empty, fall back to existing `currentIndex - 1` (which keeps Sequential's wrap behavior; Random returns null). `prev` itself does NOT push to history. |
| `clear()` | `this.history = []` |
| `setMode(m)` | `this.history = []` (mode change resets context) |
| `remove(idx)` | Drop matching entries from history; shift any entry `> idx` by `-1`. Same logic as the existing `playedIndices` rebuild. |

**`prev()` rewrite:**

```ts
prev(): QueuedSong | null {
  if (this.songs.length === 0) return null;
  // History-driven path (preferred when we have one)
  while (this.history.length > 0) {
    const idx = this.history.pop()!;
    if (idx >= 0 && idx < this.songs.length) {
      this.currentIndex = idx;
      this.playedIndices.add(idx);
      return this.songs[idx];
    }
    // popped index is stale (song removed) — keep popping
  }
  // Fallback: old index-based prev
  const prevIndex = this.currentIndex - 1;
  if (prevIndex < 0) {
    if (this.mode === PlayMode.Sequential) return null;
    this.currentIndex = this.songs.length - 1;
  } else {
    this.currentIndex = prevIndex;
  }
  this.playedIndices.add(this.currentIndex);
  return this.songs[this.currentIndex];
}
```

### B. Play Next (insert after current)

**`PlayQueue.addNext(song)`:**

```ts
addNext(song: QueuedSong): void {
  if (this.currentIndex < 0 || this.songs.length === 0) {
    this.songs.push(song);
    return;
  }
  const insertAt = this.currentIndex + 1;
  this.songs.splice(insertAt, 0, song);
  // Shift any tracked index > currentIndex by +1
  const shifted = new Set<number>();
  for (const i of this.playedIndices) {
    shifted.add(i > this.currentIndex ? i + 1 : i);
  }
  this.playedIndices = shifted;
  this.history = this.history.map((i) => (i > this.currentIndex ? i + 1 : i));
}
```

**Backend endpoint** — `src/web/api/player.ts`:

```
POST /api/player/:botId/play-next-song
body: { song: Song }
```

Behavior:
- If queue is empty or `currentIndex < 0`: `queue.addNext(song)` (which falls
  through to plain push), then `queue.play()`, then `resolveAndPlay`. Same
  semantics as a successful `/play-song` — message: "正在播放：…"
- Otherwise: `queue.addNext(song)`, no resolveAndPlay. Message: "已加入下一首：…"
- Returns `{ ok: boolean, message: string }` matching the convention
  established in the previous round.

**Bot command** — `src/bot/instance.ts`:

Register `!playnext <query>` (alias `!pn`):
- Mirror of `cmdPlay`'s search step
- On match: `queue.addNext(song)`. If no current playback, fall through to
  `resolveAndPlay`.
- Reply with `已加入下一首：<name>` or `正在播放：<name>` accordingly

**Frontend store action** — `web/src/stores/player.ts`:

```ts
async playNextSong(song: Song) {
  if (!this.activeBotId) return;
  const res = await axios.post(`/api/player/${this.activeBotId}/play-next-song`, { song });
  if (res.data?.message) {
    this.notify(res.data.message, res.data.ok === false ? 'error' : 'info');
  }
}
```

**Frontend SongCard** — `web/src/components/SongCard.vue`:

Add a third action button between the existing "play" and "add to queue":

```vue
<button class="action-btn" @click.stop="$emit('playNext')" title="下一首播放">
  <Icon icon="mdi:playlist-play" />
</button>
```

Add `playNext: []` to `defineEmits`.

**Caller updates** — `Home.vue`, `Library.vue`, `Search.vue`, `History.vue`,
`Playlist.vue`: each `<SongCard>` usage adds
`@playNext="store.playNextSong(song)"`.

**Queue.vue** is intentionally **not** updated — clicking "play next" on a
song already in the queue would create a confusing duplicate.

## Edge Cases

| Case | Behavior |
|---|---|
| `prev` with empty history in Sequential mode | Walks `currentIndex - 1`; returns null at index 0 (existing) |
| `prev` with empty history in Random/RandomLoop | Returns null (no past to recover) |
| Repeated `prev` past start of history | Pops what's there, then falls back to index walk; eventually null |
| `addNext` while `currentIndex == -1` (nothing played yet) | Falls through to push; queue.play() will pick it as first |
| `addNext` while playing and queue size = 1 | Inserts at index 1; current index unchanged; next() will advance to it |
| `remove` removes a song whose index is in history | Entry dropped; shifted accordingly |
| Mode switched mid-playback | History cleared (intentional — mode change is a context boundary) |
| `addNext` then `prev` | Inserted song was never played → not in history; prev pops the previously-played song, NOT the just-inserted one |

## Files Touched

- `src/audio/queue.ts` — history field, `pushHistory`, `addNext`, rewritten `prev`, mutator updates
- `src/audio/queue.test.ts` (or add if missing) — unit tests for history behavior + addNext shift logic
- `src/bot/instance.ts` — register `!playnext` / `!pn` command handler
- `src/web/api/player.ts` — new `/play-next-song` route
- `web/src/stores/player.ts` — `playNextSong` action
- `web/src/components/SongCard.vue` — third action button + emit
- `web/src/views/Home.vue` — wire `@playNext`
- `web/src/views/Library.vue` — wire `@playNext`
- `web/src/views/Search.vue` — wire `@playNext`
- `web/src/views/History.vue` — wire `@playNext`
- `web/src/views/Playlist.vue` — wire `@playNext`

## Test Plan

**Unit (vitest, `queue.test.ts`):**
- prev with empty history in Sequential: walks back, null at index 0
- prev with empty history in Random: returns null
- next → next → next → prev pops correctly; prev again pops earlier
- prev after `clear()` returns null (history reset)
- prev after `setMode()` returns null (history reset)
- `remove(idx)` drops from history and shifts entries > idx
- `addNext` while empty: appends
- `addNext` while playing index 2 in a 5-song queue: ends up at index 3, currentIndex still 2, queue size 6
- `addNext` then `next()`: plays the inserted song
- `addNext` shifts existing playedIndices and history correctly

**Integration (manual smoke):**
- Random mode: play 4 songs, hit `prev` 3 times → walks back through history
- Click "下一首播放" on a search result → next song after current is the chosen one
- `!playnext 七里香` → bot replies "已加入下一首：..."; current keeps playing; next song is 七里香
- `!playnext` while idle → starts playing immediately

**Regression:**
- Existing 161 source-tree tests still pass.
- TypeScript `tsc --noEmit` and `npm run build:web` clean.
