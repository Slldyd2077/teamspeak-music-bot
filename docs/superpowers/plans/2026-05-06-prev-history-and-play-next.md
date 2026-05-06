# History-aware `prev` + Play Next Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `prev` walk back through real play history (not array index) in random modes, and add a "Play Next" insert path with both UI button and `!playnext` chat command.

**Architecture:** Add a 50-entry back-stack `history` to `PlayQueue`. Mutators push the previous `currentIndex` before changing it; `prev` pops and falls back to the existing index-walk when the stack is empty. New `addNext(song)` splices into `currentIndex+1` and shifts `playedIndices` and `history` to keep references valid. Backend exposes `POST /play-next-song` and `!playnext` command. Frontend adds a third action button on `SongCard` and a `playNextSong(song)` store action that surfaces backend `{ok, message}` via the existing Toast.

**Tech Stack:** TypeScript, Vue 3 (Composition API), Pinia, Vitest, Express.

**Spec:** `docs/superpowers/specs/2026-05-06-prev-history-and-play-next-design.md`

---

## File Structure

**Modified (TDD-backed):**
- `src/audio/queue.ts` — `history` field, `pushHistory`, `addNext`, rewritten `prev`, mutator updates (`next`, `playAt`, `play`, `clear`, `setMode`, `remove`)
- `src/audio/queue.test.ts` — new test cases for history + addNext

**Modified (smoke-tested):**
- `src/bot/instance.ts` — `cmdPlayNext` method, register `playnext` / `pn` in `AUDIO_COMMANDS` and the command switch, help text update
- `src/web/api/player.ts` — `POST /:botId/play-next-song` route
- `web/src/stores/player.ts` — `playNextSong(song)` action
- `web/src/components/SongCard.vue` — third action button + emit
- `web/src/views/Home.vue` — wire `@playNext` (2 SongCard usages)
- `web/src/views/Library.vue` — wire `@playNext` (1 SongCard usage)
- `web/src/views/Search.vue` — wire `@playNext`
- `web/src/views/History.vue` — wire `@playNext`
- `web/src/views/Playlist.vue` — wire `@playNext`

**Untouched:**
- `web/src/components/Queue.vue` — songs already in queue; play-next there has confusing semantics, deliberately skipped per spec.

---

## Task 1: Queue history field + pushHistory helper (no behavior change yet)

**Files:**
- Modify: `src/audio/queue.ts`

This is a no-op refactor to set up the history infrastructure. `prev` still uses the old code path until Task 2.

- [ ] **Step 1.1: Add the field and helper**

In `src/audio/queue.ts`, find the `private playedIndices = new Set<number>();` line in the `PlayQueue` class (around line 23) and add immediately after:

```ts
  private history: number[] = [];
  private static readonly HISTORY_LIMIT = 50;

  private pushHistory(idx: number): void {
    if (idx < 0 || idx >= this.songs.length) return;
    this.history.push(idx);
    if (this.history.length > PlayQueue.HISTORY_LIMIT) {
      this.history.shift();
    }
  }
```

- [ ] **Step 1.2: Verify tests still pass**

Run: `npm test -- src/audio/queue.test.ts`
Expected: all existing PlayQueue tests pass (no behavior change).

- [ ] **Step 1.3: Commit**

```
git add src/audio/queue.ts
git commit -m "refactor(queue): add history field and pushHistory helper

Inert in this commit — no callers yet. Sets up the back-stack used
by the upcoming history-aware prev rewrite.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: History-aware `prev` (TDD)

**Files:**
- Modify: `src/audio/queue.ts`
- Modify: `src/audio/queue.test.ts`

- [ ] **Step 2.1: Add failing tests**

Append to `src/audio/queue.test.ts` (within the existing `describe("PlayQueue", ...)` block, before the closing `});`):

```ts
  describe("history-aware prev", () => {
    it("walks back through played indices in random mode", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.add(makeSong("d"));
      queue.add(makeSong("e"));

      // Force a deterministic random sequence: a → c → e
      queue.playAt(0);
      queue.playAt(2);
      queue.playAt(4);
      expect(queue.current()?.id).toBe("e");

      // prev pops back through history: e → c → a
      expect(queue.prev()?.id).toBe("c");
      expect(queue.prev()?.id).toBe("a");
    });

    it("returns null when history is empty in random mode", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.playAt(0);
      // No further moves → history is empty (only 'a' is current, never pushed)
      expect(queue.prev()).toBeNull();
    });

    it("preserves sequential prev when history is empty", () => {
      queue.setMode(PlayMode.Sequential);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.play();
      queue.next(); // currentIndex = 1
      // Sequential next() pushed 0 to history → prev pops back to 0
      expect(queue.prev()?.id).toBe("a");
    });

    it("clears history on play()", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.playAt(0);
      queue.playAt(1);
      queue.play(); // resets to index 0 and clears history
      expect(queue.prev()).toBeNull();
    });

    it("clears history on clear()", () => {
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.play();
      queue.next();
      queue.clear();
      queue.add(makeSong("c"));
      queue.play();
      // History was wiped — no prev path available beyond index 0
      expect(queue.prev()).toBeNull();
    });

    it("clears history on setMode()", () => {
      queue.setMode(PlayMode.Sequential);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.play();
      queue.next();
      // Mode change resets context
      queue.setMode(PlayMode.Random);
      expect(queue.prev()).toBeNull();
    });

    it("drops history entries pointing at a removed song", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.playAt(0);
      queue.playAt(1); // history: [0]
      queue.playAt(2); // history: [0, 1]
      // Remove song at index 1 → history entry 1 dropped
      queue.remove(1);
      // queue is now [a, c], history should be [0]
      // current was at 2 → after remove shifts to 1 → song "c"
      expect(queue.current()?.id).toBe("c");
      expect(queue.prev()?.id).toBe("a");
    });

    it("does not push to history on prev itself", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.playAt(0);
      queue.playAt(1);
      queue.playAt(2); // history: [0, 1]
      queue.prev();    // pops 1, history: [0]
      queue.prev();    // pops 0, history: []
      expect(queue.prev()).toBeNull(); // no fallback target in random mode
    });
  });
```

- [ ] **Step 2.2: Run tests, verify the new ones fail**

Run: `npm test -- src/audio/queue.test.ts`
Expected: 8 new tests fail, existing tests pass.

- [ ] **Step 2.3: Wire `pushHistory` into mutators**

In `src/audio/queue.ts`:

**Find** the `play()` method:
```ts
  play(): QueuedSong | null {
    if (this.songs.length === 0) return null;
    this.playedIndices.clear();
    this.currentIndex = 0;
    this.playedIndices.add(0);
    return this.songs[0];
  }
```
**Replace with:**
```ts
  play(): QueuedSong | null {
    if (this.songs.length === 0) return null;
    this.playedIndices.clear();
    this.history = [];
    this.currentIndex = 0;
    this.playedIndices.add(0);
    return this.songs[0];
  }
```

**Find** `playAt(index)`:
```ts
  playAt(index: number): QueuedSong | null {
    if (index < 0 || index >= this.songs.length) return null;
    this.playedIndices.clear();
    this.currentIndex = index;
    this.playedIndices.add(index);
    return this.songs[index];
  }
```
**Replace with:**
```ts
  playAt(index: number): QueuedSong | null {
    if (index < 0 || index >= this.songs.length) return null;
    this.pushHistory(this.currentIndex);
    this.currentIndex = index;
    this.playedIndices.add(index);
    return this.songs[index];
  }
```

Note: removed `playedIndices.clear()`. Random mode in `next()` reads `playedIndices` to pick unplayed songs; clearing on every `playAt` would defeat that. The test `it("walks back through played indices in random mode")` exercises this — three `playAt`s in a row should each push to history.

**Find** `next()`:
```ts
  next(): QueuedSong | null {
    if (this.songs.length === 0) return null;

    switch (this.mode) {
      case PlayMode.Sequential: {
        const nextIndex = this.currentIndex + 1;
        if (nextIndex >= this.songs.length) return null;
        this.currentIndex = nextIndex;
        return this.songs[nextIndex];
      }
      case PlayMode.Loop: {
        this.currentIndex = (this.currentIndex + 1) % this.songs.length;
        return this.songs[this.currentIndex];
      }
      case PlayMode.Random: {
        const unplayed: number[] = [];
        for (let i = 0; i < this.songs.length; i++) {
          if (!this.playedIndices.has(i)) unplayed.push(i);
        }
        if (unplayed.length === 0) return null;
        const nextIndex =
          unplayed[Math.floor(Math.random() * unplayed.length)];
        this.currentIndex = nextIndex;
        this.playedIndices.add(nextIndex);
        return this.songs[nextIndex];
      }
      case PlayMode.RandomLoop: {
        if (this.songs.length === 1) {
          this.currentIndex = 0;
          return this.songs[0];
        }
        let idx: number;
        do {
          idx = Math.floor(Math.random() * this.songs.length);
        } while (idx === this.currentIndex);
        this.currentIndex = idx;
        return this.songs[idx];
      }
    }
  }
```
**Replace with:**
```ts
  next(): QueuedSong | null {
    if (this.songs.length === 0) return null;

    switch (this.mode) {
      case PlayMode.Sequential: {
        const nextIndex = this.currentIndex + 1;
        if (nextIndex >= this.songs.length) return null;
        this.pushHistory(this.currentIndex);
        this.currentIndex = nextIndex;
        return this.songs[nextIndex];
      }
      case PlayMode.Loop: {
        this.pushHistory(this.currentIndex);
        this.currentIndex = (this.currentIndex + 1) % this.songs.length;
        return this.songs[this.currentIndex];
      }
      case PlayMode.Random: {
        const unplayed: number[] = [];
        for (let i = 0; i < this.songs.length; i++) {
          if (!this.playedIndices.has(i)) unplayed.push(i);
        }
        if (unplayed.length === 0) return null;
        const nextIndex =
          unplayed[Math.floor(Math.random() * unplayed.length)];
        this.pushHistory(this.currentIndex);
        this.currentIndex = nextIndex;
        this.playedIndices.add(nextIndex);
        return this.songs[nextIndex];
      }
      case PlayMode.RandomLoop: {
        if (this.songs.length === 1) {
          this.pushHistory(this.currentIndex);
          this.currentIndex = 0;
          return this.songs[0];
        }
        let idx: number;
        do {
          idx = Math.floor(Math.random() * this.songs.length);
        } while (idx === this.currentIndex);
        this.pushHistory(this.currentIndex);
        this.currentIndex = idx;
        return this.songs[idx];
      }
    }
  }
```

**Find** `clear()`:
```ts
  clear(): void {
    this.songs = [];
    this.currentIndex = -1;
    this.playedIndices.clear();
  }
```
**Replace with:**
```ts
  clear(): void {
    this.songs = [];
    this.currentIndex = -1;
    this.playedIndices.clear();
    this.history = [];
  }
```

**Find** `setMode(mode)`:
```ts
  setMode(mode: PlayMode): void {
    this.mode = mode;
    this.playedIndices.clear();
    if (this.currentIndex >= 0) {
      this.playedIndices.add(this.currentIndex);
    }
  }
```
**Replace with:**
```ts
  setMode(mode: PlayMode): void {
    this.mode = mode;
    this.playedIndices.clear();
    this.history = [];
    if (this.currentIndex >= 0) {
      this.playedIndices.add(this.currentIndex);
    }
  }
```

**Find** `remove(index)`:
```ts
  remove(index: number): QueuedSong | null {
    if (index < 0 || index >= this.songs.length) return null;
    const [removed] = this.songs.splice(index, 1);

    if (index < this.currentIndex) {
      this.currentIndex--;
    } else if (index === this.currentIndex) {
      this.currentIndex--;
    }

    // Rebuild playedIndices to account for shifted indices
    const newPlayed = new Set<number>();
    for (const idx of this.playedIndices) {
      if (idx === index) continue;
      newPlayed.add(idx > index ? idx - 1 : idx);
    }
    this.playedIndices = newPlayed;

    return removed;
  }
```
**Replace with:**
```ts
  remove(index: number): QueuedSong | null {
    if (index < 0 || index >= this.songs.length) return null;
    const [removed] = this.songs.splice(index, 1);

    if (index < this.currentIndex) {
      this.currentIndex--;
    } else if (index === this.currentIndex) {
      this.currentIndex--;
    }

    // Rebuild playedIndices to account for shifted indices
    const newPlayed = new Set<number>();
    for (const idx of this.playedIndices) {
      if (idx === index) continue;
      newPlayed.add(idx > index ? idx - 1 : idx);
    }
    this.playedIndices = newPlayed;

    // Same shift logic for history — drop entries pointing at the
    // removed song; shift entries > index down by 1.
    this.history = this.history
      .filter((idx) => idx !== index)
      .map((idx) => (idx > index ? idx - 1 : idx));

    return removed;
  }
```

- [ ] **Step 2.4: Rewrite `prev()`**

**Find** `prev()`:
```ts
  prev(): QueuedSong | null {
    if (this.songs.length === 0) return null;
    const prevIndex = this.currentIndex - 1;
    if (prevIndex < 0) {
      // In Sequential mode, don't wrap around
      if (this.mode === PlayMode.Sequential) return null;
      this.currentIndex = this.songs.length - 1;
    } else {
      this.currentIndex = prevIndex;
    }
    this.playedIndices.add(this.currentIndex);
    return this.songs[this.currentIndex];
  }
```
**Replace with:**
```ts
  prev(): QueuedSong | null {
    if (this.songs.length === 0) return null;

    // Preferred: pop from the back-stack so prev means "the song I
    // actually played before this one," not "the previous array slot."
    while (this.history.length > 0) {
      const idx = this.history.pop()!;
      if (idx >= 0 && idx < this.songs.length) {
        this.currentIndex = idx;
        this.playedIndices.add(idx);
        return this.songs[idx];
      }
      // Stale entry (song removed) — keep popping.
    }

    // Fallback: no history to walk back through. In Sequential we
    // can still meaningfully step the index backward; in random
    // modes there's nothing useful to return.
    if (this.mode === PlayMode.Random || this.mode === PlayMode.RandomLoop) {
      return null;
    }
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

- [ ] **Step 2.5: Run all queue tests**

Run: `npm test -- src/audio/queue.test.ts`
Expected: all tests pass (existing + 8 new).

- [ ] **Step 2.6: Run full test suite to confirm no regression**

Run: `npm test`
Expected: source-tree tests show same baseline as before plus the 8 new tests in `src/audio/queue.test.ts`. The 2 known pre-existing failures in `dist/` and `.claude/worktrees/` should still be exactly 2.

- [ ] **Step 2.7: Commit**

```
git add src/audio/queue.ts src/audio/queue.test.ts
git commit -m "feat(queue): history-aware prev that walks real play history

In random modes, prev was just doing currentIndex-1 in the array, which
has no relationship to what the user actually played before. Add a
50-entry back-stack that's pushed by next/playAt, popped by prev, reset
on play/clear/setMode, and shifted by remove. Sequential and Loop modes
keep their old fallback for the case where history is empty.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Queue `addNext` (TDD)

**Files:**
- Modify: `src/audio/queue.ts`
- Modify: `src/audio/queue.test.ts`

- [ ] **Step 3.1: Add failing tests**

Append to `src/audio/queue.test.ts` (still inside the outer `describe("PlayQueue", ...)`):

```ts
  describe("addNext", () => {
    it("appends when queue is empty (no current)", () => {
      queue.addNext(makeSong("a"));
      expect(queue.size()).toBe(1);
      expect(queue.list()[0].id).toBe("a");
    });

    it("appends when nothing is currently playing (currentIndex < 0)", () => {
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      // No play() yet → currentIndex still -1
      queue.addNext(makeSong("c"));
      expect(queue.list().map((s) => s.id)).toEqual(["a", "b", "c"]);
    });

    it("inserts at currentIndex+1 mid-queue", () => {
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.add(makeSong("d"));
      queue.play();      // current = 0 (a)
      queue.next();      // current = 1 (b)
      queue.addNext(makeSong("x"));
      expect(queue.list().map((s) => s.id)).toEqual(["a", "b", "x", "c", "d"]);
      expect(queue.current()?.id).toBe("b"); // current unchanged
    });

    it("makes the inserted song play next when next() is called", () => {
      queue.setMode(PlayMode.Sequential);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.play();      // current = 0 (a)
      queue.addNext(makeSong("x"));
      expect(queue.next()?.id).toBe("x");
    });

    it("shifts playedIndices entries > currentIndex by +1", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.add(makeSong("d"));
      queue.playAt(2); // current = 2 (c), played = {2}
      queue.playAt(3); // current = 3 (d), played = {2, 3}
      queue.playAt(2); // current = 2 (c), played = {2, 3}
      // Now insert after c — d's index 3 should become 4
      queue.addNext(makeSong("x"));
      expect(queue.list().map((s) => s.id)).toEqual(["a", "b", "c", "x", "d"]);
      // After addNext: currentIndex still 2; played should be {2, 4}
      // (the previously-played 'd' is now at index 4)
      // Verify by removing 'x' (index 3) — d should remain played at index 3
      queue.remove(3);
      expect(queue.list().map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("shifts history entries > currentIndex by +1", () => {
      queue.setMode(PlayMode.Random);
      queue.add(makeSong("a"));
      queue.add(makeSong("b"));
      queue.add(makeSong("c"));
      queue.add(makeSong("d"));
      queue.playAt(0); // current = 0
      queue.playAt(3); // current = 3 (d), history = [0]
      queue.playAt(1); // current = 1 (b), history = [0, 3]
      queue.addNext(makeSong("x"));
      // Insert at index 2 → entries > 1 shift +1 → history becomes [0, 4]
      // queue: [a, b, x, c, d]; d is now at index 4
      // prev → pop 4 → song at index 4 = d
      expect(queue.prev()?.id).toBe("d");
      // prev again → pop 0 → song at index 0 = a
      expect(queue.prev()?.id).toBe("a");
    });
  });
```

- [ ] **Step 3.2: Run tests, verify they fail**

Run: `npm test -- src/audio/queue.test.ts`
Expected: 6 new addNext tests fail with "addNext is not a function" (or similar).

- [ ] **Step 3.3: Implement `addNext`**

In `src/audio/queue.ts`, find `addMany` (around line 29-31):

```ts
  addMany(songs: QueuedSong[]): void {
    this.songs.push(...songs);
  }
```

**Add a new method immediately after** `addMany`:

```ts
  /**
   * Insert a song to play immediately after the current one. Falls
   * through to plain push when nothing is playing yet (currentIndex < 0
   * or queue empty), so the existing "add → idle bot starts playing"
   * flow continues to work.
   *
   * Shifts playedIndices and history entries > currentIndex by +1 so
   * their references stay valid after the splice.
   */
  addNext(song: QueuedSong): void {
    if (this.currentIndex < 0 || this.songs.length === 0) {
      this.songs.push(song);
      return;
    }
    const insertAt = this.currentIndex + 1;
    this.songs.splice(insertAt, 0, song);

    const shifted = new Set<number>();
    for (const i of this.playedIndices) {
      shifted.add(i > this.currentIndex ? i + 1 : i);
    }
    this.playedIndices = shifted;

    this.history = this.history.map((i) =>
      i > this.currentIndex ? i + 1 : i,
    );
  }
```

- [ ] **Step 3.4: Run queue tests**

Run: `npm test -- src/audio/queue.test.ts`
Expected: all PlayQueue tests pass (existing + 8 from Task 2 + 6 new).

- [ ] **Step 3.5: Commit**

```
git add src/audio/queue.ts src/audio/queue.test.ts
git commit -m "feat(queue): addNext inserts a song to play right after current

Splices into currentIndex+1 and shifts both playedIndices and the
history back-stack to keep references valid. Falls through to plain
push when nothing is playing so the idle-bot \"add → start playing\"
flow is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Backend `/play-next-song` endpoint + `!playnext` command

**Files:**
- Modify: `src/web/api/player.ts`
- Modify: `src/bot/instance.ts`

- [ ] **Step 4.1: Add the REST endpoint**

In `src/web/api/player.ts`, find the existing `/add-song` route (around line 343). **Add a new route** immediately before it (so it sits next to other "play" endpoints):

```ts
  // Insert a single song to play right after the current one.
  // If nothing is playing, behaves like /play-song (start immediately).
  router.post("/:botId/play-next-song", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
      const queue = bot.getQueueManager();
      const wasIdle = bot.getPlayer().getState() === "idle";
      queue.addNext(song);

      if (wasIdle) {
        // No current playback — promote the just-added song to current
        // and start it. addNext fell through to push, so it's the last item.
        queue.playAt(queue.size() - 1);
        bot.getPlayer().resetFailures();
        const ok = await bot.resolveAndPlay(queue.current()!);
        if (!ok) {
          res.json({ ok: false, message: `无法播放「${song.name || song.id}」（区域/版权限制）` });
          return;
        }
        res.json({ ok: true, message: `正在播放：${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` });
        return;
      }

      res.json({ ok: true, message: `已加入下一首：${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
```

- [ ] **Step 4.2: Add the `cmdPlayNext` method**

In `src/bot/instance.ts`, find `cmdAdd` (around line 405-429). **Add a new method** immediately after `cmdAdd`:

```ts
  private async cmdPlayNext(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !playnext <song name>";
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 1);
    if (result.songs.length === 0)
      return `No results found for: ${cmd.args}`;

    const song = result.songs[0];
    const wasIdle = this.player.getState() === "idle";
    this.queue.addNext({ ...song, platform: provider.platform });

    if (wasIdle) {
      // Nothing playing — addNext fell through to push, promote and start.
      this.queue.playAt(this.queue.size() - 1);
      this.player.resetFailures();
      const ok = await this.resolveAndPlay(this.queue.current()!);
      this.emit("stateChange");
      if (!ok) return `Cannot play: ${song.name}`;
      return `Now playing: ${song.name} - ${song.artist}`;
    }

    this.emit("stateChange");
    return `Up next: ${song.name} - ${song.artist}`;
  }
```

- [ ] **Step 4.3: Register the command**

In `src/bot/instance.ts`, find the `AUDIO_COMMANDS` set (around line 254-264):

```ts
    const AUDIO_COMMANDS = new Set([
      "play",
      "add",
      "next",
      "skip",
      "prev",
      "playlist",
      "album",
      "fm",
      "artist",
    ]);
```

**Replace with:**

```ts
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
```

Find the command switch (around line 268). **After** the `case "add": return this.cmdAdd(cmd);` line, **add:**

```ts
      case "playnext":
      case "pn":
        return this.cmdPlayNext(cmd);
```

- [ ] **Step 4.4: Update help text**

In `src/bot/instance.ts`, find `cmdHelp` (around line 709). **Find the line:**

```ts
      `${p}add <song>   — Add to queue`,
```

**Replace with:**

```ts
      `${p}add <song>   — Add to queue`,
      `${p}playnext <song> — Insert as next song (alias: ${p}pn)`,
```

- [ ] **Step 4.5: Type-check**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 4.6: Smoke test**

Make sure dev server is running (`npm run dev` if not). Then verify:

```
curl -s -X POST "http://localhost:3000/api/player/<botId>/play-next-song" \
  -H "Content-Type: application/json" \
  -d '{"song":{"id":"002CGrO91icqlg","name":"测试","artist":"测试","album":"","duration":200,"coverUrl":"","platform":"qq"}}' | head -c 200
```

Replace `<botId>` with one from `curl http://localhost:3000/api/bot`. Expected response shape: `{"ok":true,"message":"已加入下一首：…"}` (when bot is playing) or `{"ok":true,"message":"正在播放：…"}` (when idle).

- [ ] **Step 4.7: Commit**

```
git add src/web/api/player.ts src/bot/instance.ts
git commit -m "feat: !playnext command and /play-next-song endpoint

Mirror of !play / /play-song but uses queue.addNext to splice in at
currentIndex+1 instead of clearing the queue. Idle bot still starts
the song immediately. Adds 'playnext' / 'pn' to AUDIO_COMMANDS, the
command switch, and the help text.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend `playNextSong` store action

**Files:**
- Modify: `web/src/stores/player.ts`

- [ ] **Step 5.1: Add the action**

In `web/src/stores/player.ts`, find the `playSong(song: Song)` action (search for `async playSong`). **Add a new action** immediately after `playSong`:

```ts
    async playNextSong(song: Song) {
      if (!this.activeBotId) return;
      const res = await axios.post(`/api/player/${this.activeBotId}/play-next-song`, { song });
      if (res.data?.message) {
        this.notify(res.data.message, res.data.ok === false ? 'error' : 'info');
      }
      // Refresh queue so the inserted item shows up in the side panel
      this.fetchQueue();
    },
```

- [ ] **Step 5.2: Type-check the web project**

Run: `cd web && npx vue-tsc --noEmit && cd ..`
Expected: exit 0, no output.

- [ ] **Step 5.3: Commit**

```
git add web/src/stores/player.ts
git commit -m "feat(web): playNextSong store action

Posts to /play-next-song, surfaces failures via the existing Toast,
and refreshes the queue panel so the inserted song appears.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: SongCard third action button

**Files:**
- Modify: `web/src/components/SongCard.vue`

- [ ] **Step 6.1: Add the button and emit**

Read `web/src/components/SongCard.vue`. Find the action buttons block:

```vue
    <div class="song-actions">
      <button class="action-btn" @click.stop="$emit('play')" title="播放">
        <Icon icon="mdi:play" />
      </button>
      <button class="action-btn" @click.stop="$emit('add')" title="添加到队列">
        <Icon icon="mdi:playlist-plus" />
      </button>
    </div>
```

**Replace with:**

```vue
    <div class="song-actions">
      <button class="action-btn" @click.stop="$emit('play')" title="播放">
        <Icon icon="mdi:play" />
      </button>
      <button class="action-btn" @click.stop="$emit('playNext')" title="下一首播放">
        <Icon icon="mdi:playlist-play" />
      </button>
      <button class="action-btn" @click.stop="$emit('add')" title="添加到队列">
        <Icon icon="mdi:playlist-plus" />
      </button>
    </div>
```

In the `defineEmits` block, find:

```ts
defineEmits<{
  play: [];
  add: [];
}>();
```

**Replace with:**

```ts
defineEmits<{
  play: [];
  playNext: [];
  add: [];
}>();
```

- [ ] **Step 6.2: Verify the web build**

Run: `npm run build:web`
Expected: build succeeds with `✓ built in N.NNs`. The `vue-tsc --noEmit` step is part of `build:web` so any type mismatch on existing SongCard usages would surface here.

- [ ] **Step 6.3: Commit**

```
git add web/src/components/SongCard.vue
git commit -m "feat(web): third 'play next' action on SongCard

Button sits between Play and Add to queue. Icon is mdi:playlist-play,
title '下一首播放'. Emits 'playNext' for callers to wire up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wire `@playNext` on all SongCard call sites

**Files:**
- Modify: `web/src/views/Home.vue`
- Modify: `web/src/views/Library.vue`
- Modify: `web/src/views/Search.vue`
- Modify: `web/src/views/History.vue`
- Modify: `web/src/views/Playlist.vue`

- [ ] **Step 7.1: Home.vue**

In `web/src/views/Home.vue`, there are no `<SongCard>` usages — the Home page renders songs through ad-hoc `daily-card` divs. **Skip this file**; the SongCard third button only matters where SongCard is actually rendered.

- [ ] **Step 7.2: Library.vue**

In `web/src/views/Library.vue`, find:

```vue
        <SongCard
          v-for="(song, i) in history.slice(0, 10)"
          :key="`hist-${song.id}-${i}`"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @play="store.play(song.name, song.platform)"
          @add="store.addToQueue(song.name, song.platform)"
        />
```

**Replace with:**

```vue
        <SongCard
          v-for="(song, i) in history.slice(0, 10)"
          :key="`hist-${song.id}-${i}`"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @play="store.play(song.name, song.platform)"
          @playNext="store.playNextSong(song)"
          @add="store.addToQueue(song.name, song.platform)"
        />
```

- [ ] **Step 7.3: Search.vue**

In `web/src/views/Search.vue`, find the `<SongCard ...>` usage and add `@playNext="store.playNextSong(song)"` on a new line right before `@play="..."`. The exact existing handler may be `@play="store.playSong(song)"` — keep it; just add the `@playNext` line above.

The full block should end up like:

```vue
        <SongCard
          v-for="(song, i) in results.songs"
          :key="`search-${song.id}-${i}`"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @playNext="store.playNextSong(song)"
          @play="store.playSong(song)"
          @add="store.addSong(song)"
        />
```

(If the existing `@play=` or `@add=` handlers differ, leave them as-is — only add the new `@playNext` line.)

- [ ] **Step 7.4: History.vue**

Same pattern — in `web/src/views/History.vue`, locate the `<SongCard>` usage and add `@playNext="store.playNextSong(song)"`. Result should look like:

```vue
        <SongCard
          v-for="(song, i) in records"
          :key="`hist-${song.id}-${i}`"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @playNext="store.playNextSong(song)"
          @play="store.playSong(song)"
          @add="store.addSong(song)"
        />
```

- [ ] **Step 7.5: Playlist.vue**

In `web/src/views/Playlist.vue`, find:

```vue
        <SongCard
          v-for="(song, i) in songs"
          :key="song.id"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @play="store.playSong(song)"
          @add="store.addSong(song)"
        />
```

**Replace with:**

```vue
        <SongCard
          v-for="(song, i) in songs"
          :key="song.id"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @play="store.playSong(song)"
          @playNext="store.playNextSong(song)"
          @add="store.addSong(song)"
        />
```

- [ ] **Step 7.6: Verify the build**

Run: `npm run build:web`
Expected: clean build.

- [ ] **Step 7.7: Commit**

```
git add web/src/views/Library.vue web/src/views/Search.vue web/src/views/History.vue web/src/views/Playlist.vue
git commit -m "feat(web): wire @playNext on all SongCard call sites

Library / Search / History / Playlist now route the third action to
store.playNextSong. Home is unchanged (it doesn't use SongCard).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Verify the whole thing

- [ ] **Step 8.1: Type check + build**

```
npx tsc --noEmit
npm run build:web
```

Expected: both clean.

- [ ] **Step 8.2: Run the test suite**

```
npm test
```

Expected: source-tree tests show prior count + 14 new in `queue.test.ts` (8 from Task 2 + 6 from Task 3) all passing. The 2 pre-existing failures in `dist/` and `.claude/worktrees/` should still be exactly 2.

- [ ] **Step 8.3: Manual smoke (web)**

The dev server should pick up the rebuilt bundle from `web/dist/` automatically (the backend serves static files). Hard reload the browser (Ctrl+Shift+R) and exercise:

1. Find a SongCard somewhere (e.g., Search results) — confirm three action buttons (play / playlist-play / playlist-plus).
2. Click the middle button on a song. Toast should show "已加入下一首：…". Open the queue panel — the song is now at position currentIndex+1.
3. Click `next` (or wait for current to end). The inserted song plays.

- [ ] **Step 8.4: Manual smoke (TS3 chat)**

In the bot's TS channel:
- `!playnext 七里香` → bot replies "Up next: 七里香 - 周杰伦" (or "Now playing:" if idle).
- `!pn 同桌的你` → same as above (alias).

- [ ] **Step 8.5: Manual smoke (history-aware prev)**

Set Random mode in the web UI (Player → mode dropdown → 随机). Play a playlist with 4+ songs. Let `next` run twice (or click skip twice). Click `prev` — should land on the song you played 2 ago, not a freshly random one. Click `prev` again — earlier song. Click `next` — picks a new random song.

- [ ] **Step 8.6: Done**

```
git log --oneline -10
```
Expected: 7 new commits from Tasks 1-7 on top of `58bdfb9` (the spec commit). All tasks checkboxes ticked.

---

## Self-Review Checklist (already applied)

- All 8 unit tests for history + 6 for addNext are written with concrete code, not "test similar behaviors".
- Method signatures match across tasks: `pushHistory` (Task 1) used in `next`/`playAt` (Task 2.3); `addNext` (Task 3) called by REST + command (Task 4); `playNextSong` (Task 5) called by views (Task 7).
- No "TODO" / "fill in details". Code blocks present in every editing step.
- Spec coverage:
  - History stack ✅ Tasks 1-2
  - addNext ✅ Task 3
  - REST endpoint ✅ Task 4.1
  - !playnext + !pn alias ✅ Task 4.2-4.4
  - Toast on failure ✅ Task 5.1 (uses existing notify primitive)
  - SongCard 3rd button ✅ Task 6
  - All 5 caller view updates ✅ Task 7 (Home is intentionally skipped per spec/codebase)
  - Tests ✅ Tasks 2.1, 3.1
  - Manual smoke plan ✅ Task 8
