# Music Source Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add NetEase / QQ source-switcher tabs to Home (推荐歌单 / 每日推荐 / 我的歌单) and Library (我的歌单), with per-section persistence and graceful degradation when only one source is logged in.

**Architecture:** A single shared `<SourceTabs>` Vue component handles the tab UI and self-hides when fewer than 2 sources are available. The Pinia store splits the affected fields into `{ netease, qq }` objects, fetches from both platforms in `fetchHomeData()` based on `authStatus`, and consumers select with a reactive `activeSource` ref persisted to localStorage.

**Tech Stack:** Vue 3 (Composition API + `<script setup>`), Pinia, TypeScript, SCSS (CSS variables from `web/src/styles/variables.scss`).

**Spec:** `docs/superpowers/specs/2026-05-06-music-source-tabs-design.md`

---

## File Structure

**New:**
- `web/src/components/SourceTabs.vue` — shared tab UI (presentational, no store deps)

**Modified:**
- `web/src/stores/player.ts` — state shape change + `authStatus` + `fetchHomeData` rewrite
- `web/src/views/Home.vue` — 3 sections wired to SourceTabs
- `web/src/views/Library.vue` — 1 section wired; remove dead `liked` block

**Unchanged:**
- Backend (already supports `?platform=qq`)
- All other web pages

---

## Task 1: Build the SourceTabs component

**Files:**
- Create: `web/src/components/SourceTabs.vue`

This task is fully independent of store changes — the component is presentational, takes typed props, and emits an update event. It can land and be committed alone (build will pass; component is just unused until later tasks).

- [ ] **Step 1.1: Create the component file**

Write `web/src/components/SourceTabs.vue`:

```vue
<template>
  <div v-if="sources.length >= 2" class="source-tabs">
    <button
      v-for="src in sources"
      :key="src"
      type="button"
      class="source-tab"
      :class="{ active: src === modelValue }"
      @click="$emit('update:modelValue', src)"
    >
      {{ LABELS[src] }}
    </button>
  </div>
</template>

<script setup lang="ts">
type Source = 'netease' | 'qq';

const LABELS: Record<Source, string> = {
  netease: '网易云',
  qq: 'QQ',
};

defineProps<{
  modelValue: Source;
  sources: Source[];
}>();

defineEmits<{
  'update:modelValue': [value: Source];
}>();
</script>

<style lang="scss" scoped>
.source-tabs {
  display: inline-flex;
  gap: 4px;
  margin-left: 12px;
  align-items: center;
}

.source-tab {
  padding: 4px 10px;
  min-height: 28px;
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--hover-bg);
  }

  &.active {
    color: var(--color-primary);
    background: var(--color-primary-12);
    font-weight: var(--fw-semi);
  }
}

@media (max-width: 768px) {
  .source-tabs {
    margin-left: 8px;
    gap: 2px;
  }

  .source-tab {
    padding: 6px 10px;
    min-height: 36px; // larger touch target on mobile
    font-size: var(--fs-xs);
  }
}
</style>
```

Why these choices:
- `v-if="sources.length >= 2"` — auto-hide when only one source available; parent doesn't need wrapper logic
- Min-height 28px desktop / 36px mobile — comfortable touch on phones
- `--color-primary-12` (12% primary tint) — matches existing active-state pattern in the codebase
- No `--brand-netease/qq` in active state — keeps tab visually consistent regardless of which platform; brand colors are reserved for SongCard platform badges where they identify content origin

- [ ] **Step 1.2: Verify it imports cleanly via type check**

Run from project root:

```
npx tsc --noEmit
```

Expected: exit code 0, no output.

Then verify the web project also type-checks:

```
cd web && npx vue-tsc --noEmit && cd ..
```

Expected: exit code 0, no output.

- [ ] **Step 1.3: Commit**

```
git add web/src/components/SourceTabs.vue
git commit -m "feat(web): add SourceTabs component for platform switcher

Presentational component for switching between netease and qq music
sources. Auto-hides when fewer than 2 sources are passed in. Mobile
breakpoint enlarges touch target to 36px.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Refactor the store (state + fetchHomeData)

**Files:**
- Modify: `web/src/stores/player.ts`

This task changes types, which will break Home.vue and Library.vue at compile time. **Do not run tsc/build between Task 2 and Task 4** — they are migrated in a single coherent commit. After Task 4, type-check confirms the whole change.

- [ ] **Step 2.1: Add the `Source` type alias and update state shape**

In `web/src/stores/player.ts`, locate the `state: () => ({ ... })` block (around line 47-63).

**Find:**

```ts
    // Home page cache
    recommendPlaylists: [] as PlaylistItem[],
    dailySongs: [] as Song[],
    userPlaylists: [] as PlaylistItem[],
    bilibiliPopular: [] as Song[],
    lastFetchTime: 0,
```

**Replace with:**

```ts
    // Home page cache, split by source
    recommendPlaylists: { netease: [] as PlaylistItem[], qq: [] as PlaylistItem[] },
    dailySongs:         { netease: [] as Song[],         qq: [] as Song[] },
    userPlaylists:      { netease: [] as PlaylistItem[], qq: [] as PlaylistItem[] },
    bilibiliPopular: [] as Song[],
    authStatus: { netease: false, qq: false },
    lastFetchTime: 0,
```

Also add this exported type at the top of the file, right after the existing `Song` interface (around line 12):

```ts
export type Source = 'netease' | 'qq';
```

- [ ] **Step 2.2: Rewrite `fetchHomeData()`**

In the same file, find the `fetchHomeData` action (around line 352-378).

**Replace the entire action body with:**

```ts
    async fetchHomeData() {
      if (this.lastFetchTime > 0 && Date.now() - this.lastFetchTime < HOME_CACHE_TTL) {
        return;
      }

      // 1. Fetch auth status for both platforms first.
      const [neAuthRes, qqAuthRes] = await Promise.allSettled([
        axios.get('/api/auth/status', { params: { platform: 'netease' } }),
        axios.get('/api/auth/status', { params: { platform: 'qq' } }),
      ]);
      this.authStatus.netease =
        neAuthRes.status === 'fulfilled' && !!neAuthRes.value.data?.loggedIn;
      this.authStatus.qq =
        qqAuthRes.status === 'fulfilled' && !!qqAuthRes.value.data?.loggedIn;

      // 2. NetEase data: recommend playlists work anonymously; daily/user
      // playlists need login but Promise.allSettled isolates failures.
      const neteasePromises = [
        axios.get('/api/music/recommend/playlists', { params: { platform: 'netease' } }),
        axios.get('/api/music/recommend/songs',     { params: { platform: 'netease' } }),
        axios.get('/api/music/user/playlists',      { params: { platform: 'netease' } }),
      ];

      // 3. QQ data: only fetch when QQ is logged in. When not logged in,
      // resolve to empty payloads so the same indexed handling works.
      const emptyPlaylists = { data: { playlists: [] } };
      const emptySongs     = { data: { songs: [] } };
      const qqPromises = this.authStatus.qq
        ? [
            axios.get('/api/music/recommend/playlists', { params: { platform: 'qq' } }),
            axios.get('/api/music/recommend/songs',     { params: { platform: 'qq' } }),
            axios.get('/api/music/user/playlists',      { params: { platform: 'qq' } }),
          ]
        : [
            Promise.resolve(emptyPlaylists),
            Promise.resolve(emptySongs),
            Promise.resolve(emptyPlaylists),
          ];

      const biliPromise = axios.get('/api/music/bilibili/popular?limit=12');

      const results = await Promise.allSettled([
        ...neteasePromises,
        ...qqPromises,
        biliPromise,
      ]);

      const [neRecPL, neDaily, neUserPL, qqRecPL, qqDaily, qqUserPL, bili] = results;

      if (neRecPL.status === 'fulfilled') {
        this.recommendPlaylists.netease = neRecPL.value.data.playlists ?? [];
      }
      if (neDaily.status === 'fulfilled') {
        this.dailySongs.netease = neDaily.value.data.songs ?? [];
      }
      if (neUserPL.status === 'fulfilled') {
        this.userPlaylists.netease = neUserPL.value.data.playlists ?? [];
      }
      if (qqRecPL.status === 'fulfilled') {
        this.recommendPlaylists.qq = qqRecPL.value.data.playlists ?? [];
      }
      if (qqDaily.status === 'fulfilled') {
        this.dailySongs.qq = qqDaily.value.data.songs ?? [];
      }
      if (qqUserPL.status === 'fulfilled') {
        this.userPlaylists.qq = qqUserPL.value.data.playlists ?? [];
      }
      if (bili.status === 'fulfilled') {
        this.bilibiliPopular = bili.value.data.songs ?? [];
      }

      this.lastFetchTime = Date.now();
    },
```

**Do NOT type-check yet** — Home/Library still reference the old shape. They'll be migrated in Tasks 3 and 4.

---

## Task 3: Migrate Home.vue to multi-source tabs

**Files:**
- Modify: `web/src/views/Home.vue`

- [ ] **Step 3.1: Add a localStorage helper module**

Create `web/src/stores/sourceTabs.ts`:

```ts
import type { Source } from './player.js';

const STORAGE_KEY = 'source-tabs';

export type TabKey =
  | 'home.recommend'
  | 'home.daily'
  | 'home.user'
  | 'library.user';

function readAll(): Partial<Record<TabKey, Source>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function loadTabSource(key: TabKey, fallback: Source = 'netease'): Source {
  const all = readAll();
  const v = all[key];
  return v === 'netease' || v === 'qq' ? v : fallback;
}

export function saveTabSource(key: TabKey, value: Source): void {
  try {
    const all = readAll();
    all[key] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // localStorage may be unavailable (private browsing); silently no-op
  }
}
```

This is a separate file rather than inline so Library can reuse it without duplication.

- [ ] **Step 3.2: Update Home.vue template**

Replace the three `<section>` blocks (推荐歌单 / 每日推荐 / 我的歌单) and the `<script setup>` block.

**Find** the entire `<template>` 推荐歌单 section (currently around lines 53-67):

```vue
    <!-- 推荐歌单 -->
    <section class="section" v-if="store.recommendPlaylists.length > 0">
      <h2 class="section-title">推荐歌单</h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="playlist in store.recommendPlaylists"
          :key="playlist.id"
          :to="`/playlist/${playlist.id}?platform=${playlist.platform}`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="playlist.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ playlist.name }}</div>
        </RouterLink>
      </div>
    </section>
```

**Replace with:**

```vue
    <!-- 推荐歌单 -->
    <section class="section" v-if="recommendAvailable.length > 0">
      <h2 class="section-title">
        推荐歌单
        <SourceTabs v-model="recommendSource" :sources="recommendAvailable" />
      </h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="playlist in (store.recommendPlaylists[recommendSourceSafe] ?? [])"
          :key="playlist.id"
          :to="`/playlist/${playlist.id}?platform=${playlist.platform}`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="playlist.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ playlist.name }}</div>
        </RouterLink>
      </div>
    </section>
```

**Find** the 每日推荐 section (currently around lines 36-51):

```vue
    <!-- 每日推荐 -->
    <section class="section" v-if="store.dailySongs.length > 0">
      <h2 class="section-title">每日推荐</h2>
      <div class="daily-grid">
        <div
          v-for="song in store.dailySongs.slice(0, 12)"
          :key="song.id"
          class="daily-card hover-scale"
          @click="store.playSong(song)"
        >
          <CoverArt :url="song.coverUrl" :size="120" :radius="10" :show-shadow="true" />
          <div class="daily-name">{{ song.name }}</div>
          <div class="daily-artist">{{ song.artist }}</div>
        </div>
      </div>
    </section>
```

**Replace with:**

```vue
    <!-- 每日推荐 -->
    <section class="section" v-if="dailyAvailable.length > 0">
      <h2 class="section-title">
        每日推荐
        <SourceTabs v-model="dailySource" :sources="dailyAvailable" />
      </h2>
      <div class="daily-grid">
        <div
          v-for="song in (store.dailySongs[dailySourceSafe] ?? []).slice(0, 12)"
          :key="song.id"
          class="daily-card hover-scale"
          @click="store.playSong(song)"
        >
          <CoverArt :url="song.coverUrl" :size="120" :radius="10" :show-shadow="true" />
          <div class="daily-name">{{ song.name }}</div>
          <div class="daily-artist">{{ song.artist }}</div>
        </div>
      </div>
    </section>
```

**Find** the 我的歌单 section (currently around lines 69-95):

```vue
    <!-- 我的歌单 -->
    <section class="section" v-if="store.userPlaylists.length > 0">
      <h2 class="section-title">
        我的歌单
        <span class="section-count">{{ store.userPlaylists.length }}</span>
      </h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="pl in visibleUserPlaylists"
          :key="pl.id"
          :to="`/playlist/${pl.id}?platform=${pl.platform}`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="pl.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ pl.name }}</div>
          <div class="playlist-count">{{ pl.songCount }} 首</div>
        </RouterLink>
      </div>
      <button
        v-if="store.userPlaylists.length > USER_PLAYLIST_LIMIT"
        class="expand-btn"
        @click="userPlaylistsExpanded = !userPlaylistsExpanded"
      >
        <Icon :icon="userPlaylistsExpanded ? 'mdi:chevron-up' : 'mdi:chevron-down'" />
        {{ userPlaylistsExpanded ? '收起' : `展开全部 ${store.userPlaylists.length} 个歌单` }}
      </button>
    </section>
```

**Replace with:**

```vue
    <!-- 我的歌单 -->
    <section class="section" v-if="userAvailable.length > 0">
      <h2 class="section-title">
        我的歌单
        <span class="section-count">{{ currentUserPlaylists.length }}</span>
        <SourceTabs v-model="userSource" :sources="userAvailable" />
      </h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="pl in visibleUserPlaylists"
          :key="pl.id"
          :to="`/playlist/${pl.id}?platform=${pl.platform}`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="pl.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ pl.name }}</div>
          <div class="playlist-count">{{ pl.songCount }} 首</div>
        </RouterLink>
      </div>
      <button
        v-if="currentUserPlaylists.length > USER_PLAYLIST_LIMIT"
        class="expand-btn"
        @click="userPlaylistsExpanded = !userPlaylistsExpanded"
      >
        <Icon :icon="userPlaylistsExpanded ? 'mdi:chevron-up' : 'mdi:chevron-down'" />
        {{ userPlaylistsExpanded ? '收起' : `展开全部 ${currentUserPlaylists.length} 个歌单` }}
      </button>
    </section>
```

- [ ] **Step 3.3: Update Home.vue `<script setup>`**

**Find** the `<script setup lang="ts">` block (currently around lines 119-153):

```ts
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore, type Song } from '../stores/player.js';
import CoverArt from '../components/CoverArt.vue';

const store = usePlayerStore();
const USER_PLAYLIST_LIMIT = 20;
const userPlaylistsExpanded = ref(false);
const visibleUserPlaylists = computed(() =>
  userPlaylistsExpanded.value
    ? store.userPlaylists
    : store.userPlaylists.slice(0, USER_PLAYLIST_LIMIT)
);

async function playFm() {
  try {
    const res = await axios.get('/api/music/personal/fm');
    const songs: Song[] = res.data.songs;
    if (songs.length > 0) {
      await store.play(songs[0].name, songs[0].platform);
      for (let i = 1; i < songs.length; i++) {
        await store.addToQueue(songs[i].name, songs[i].platform);
      }
    }
  } catch {
    // Ignore
  }
}

onMounted(() => {
  store.fetchHomeData();
});
</script>
```

**Replace with:**

```ts
<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore, type Song, type Source } from '../stores/player.js';
import { loadTabSource, saveTabSource } from '../stores/sourceTabs.js';
import CoverArt from '../components/CoverArt.vue';
import SourceTabs from '../components/SourceTabs.vue';

const store = usePlayerStore();
const USER_PLAYLIST_LIMIT = 20;
const userPlaylistsExpanded = ref(false);

// Available sources per section. Recommend playlists are public for both
// platforms — netease always; qq only when logged in. Daily and user
// playlists need login on both sides.
const recommendAvailable = computed<Source[]>(() => {
  const s: Source[] = ['netease'];
  if (store.authStatus.qq) s.push('qq');
  return s;
});
const dailyAvailable = computed<Source[]>(() => {
  const s: Source[] = [];
  if (store.authStatus.netease) s.push('netease');
  if (store.authStatus.qq) s.push('qq');
  return s;
});
const userAvailable = computed<Source[]>(() => {
  const s: Source[] = [];
  if (store.authStatus.netease) s.push('netease');
  if (store.authStatus.qq) s.push('qq');
  return s;
});

// Persisted active source per section.
const recommendSource = ref<Source>(loadTabSource('home.recommend'));
const dailySource     = ref<Source>(loadTabSource('home.daily'));
const userSource      = ref<Source>(loadTabSource('home.user'));

watch(recommendSource, (v) => saveTabSource('home.recommend', v));
watch(dailySource,     (v) => saveTabSource('home.daily',     v));
watch(userSource,      (v) => saveTabSource('home.user',      v));

// Fallback when persisted source is no longer available (e.g. user logged
// out of QQ since last visit). We render against `*Safe` but never write
// back, so the user's preference is preserved for when they log in again.
const recommendSourceSafe = computed<Source>(() =>
  recommendAvailable.value.includes(recommendSource.value)
    ? recommendSource.value
    : recommendAvailable.value[0] ?? 'netease'
);
const dailySourceSafe = computed<Source>(() =>
  dailyAvailable.value.includes(dailySource.value)
    ? dailySource.value
    : dailyAvailable.value[0] ?? 'netease'
);
const userSourceSafe = computed<Source>(() =>
  userAvailable.value.includes(userSource.value)
    ? userSource.value
    : userAvailable.value[0] ?? 'netease'
);

const currentUserPlaylists = computed(() => store.userPlaylists[userSourceSafe.value] ?? []);
const visibleUserPlaylists = computed(() =>
  userPlaylistsExpanded.value
    ? currentUserPlaylists.value
    : currentUserPlaylists.value.slice(0, USER_PLAYLIST_LIMIT)
);

async function playFm() {
  try {
    const res = await axios.get('/api/music/personal/fm');
    const songs: Song[] = res.data.songs;
    if (songs.length > 0) {
      await store.play(songs[0].name, songs[0].platform);
      for (let i = 1; i < songs.length; i++) {
        await store.addToQueue(songs[i].name, songs[i].platform);
      }
    }
  } catch {
    // Ignore
  }
}

onMounted(() => {
  store.fetchHomeData();
});
</script>
```

Note: The 我的歌单 template uses `userSource` (not `userSourceSafe`) on the `<SourceTabs>` v-model so the user's click maps directly to the persisted ref. The grid below the tabs uses `currentUserPlaylists` which derives from `userSourceSafe`, so even if `userSource` points at an unavailable platform momentarily, the grid still renders something sensible. Same pattern for 推荐歌单 / 每日推荐.

---

## Task 4: Migrate Library.vue and remove dead code

**Files:**
- Modify: `web/src/views/Library.vue`

- [ ] **Step 4.1: Replace the template**

**Find** the `<template>` block (currently lines 1-64) and **replace the entire template with:**

```vue
<template>
  <div class="library-page">
    <h1 class="page-title">音乐库</h1>

    <!-- 我的歌单 -->
    <section class="section" v-if="userAvailable.length > 0">
      <h2 class="section-title">
        我的歌单
        <span class="section-count">{{ currentUserPlaylists.length }}</span>
        <SourceTabs v-model="userSource" :sources="userAvailable" />
      </h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="pl in currentUserPlaylists"
          :key="pl.id"
          :to="`/playlist/${pl.id}?platform=${pl.platform}`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="pl.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ pl.name }}</div>
          <div class="playlist-count">{{ pl.songCount }} 首</div>
        </RouterLink>
      </div>
    </section>

    <!-- 最近播放 -->
    <section class="section">
      <h2 class="section-title">最近播放</h2>
      <div v-if="historyLoading" class="loading">加载中...</div>
      <div v-else-if="history.length === 0" class="empty">暂无播放记录</div>
      <div v-else class="song-list">
        <SongCard
          v-for="(song, i) in history.slice(0, 10)"
          :key="`hist-${song.id}-${i}`"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @play="store.play(song.name, song.platform)"
          @add="store.addToQueue(song.name, song.platform)"
        />
      </div>
    </section>

    <div v-if="!historyLoading && userAvailable.length === 0 && history.length === 0" class="empty-state">
      <Icon icon="mdi:music-box-outline" class="empty-icon" />
      <div>登录网易云或QQ音乐后，这里将显示你的歌单和播放记录</div>
    </div>
  </div>
</template>
```

Changes from the previous version:
- "我的歌单" section: same data binding pattern as Home (`userAvailable`, `currentUserPlaylists`, `<SourceTabs>`)
- "我的收藏" section: removed entirely (the `/api/music/user/liked` endpoint never existed)
- Empty state condition: replaced `liked.length === 0` with `userAvailable.length === 0`

- [ ] **Step 4.2: Replace the script block**

**Find** the `<script setup lang="ts">` block (currently lines 66-105) and **replace with:**

```ts
<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore, type Song, type Source } from '../stores/player.js';
import { loadTabSource, saveTabSource } from '../stores/sourceTabs.js';
import CoverArt from '../components/CoverArt.vue';
import SongCard from '../components/SongCard.vue';
import SourceTabs from '../components/SourceTabs.vue';

const store = usePlayerStore();

const history = ref<Song[]>([]);
const historyLoading = ref(true);

const userAvailable = computed<Source[]>(() => {
  const s: Source[] = [];
  if (store.authStatus.netease) s.push('netease');
  if (store.authStatus.qq) s.push('qq');
  return s;
});

const userSource = ref<Source>(loadTabSource('library.user'));
watch(userSource, (v) => saveTabSource('library.user', v));

const userSourceSafe = computed<Source>(() =>
  userAvailable.value.includes(userSource.value)
    ? userSource.value
    : userAvailable.value[0] ?? 'netease'
);

const currentUserPlaylists = computed(() => store.userPlaylists[userSourceSafe.value] ?? []);

onMounted(async () => {
  if (!store.activeBotId) {
    await store.fetchBots();
  }

  store.fetchHomeData();

  if (store.activeBotId) {
    try {
      const res = await axios.get(`/api/player/${store.activeBotId}/history`);
      history.value = res.data.history ?? [];
    } catch {
      // API may not be ready
    }
  }

  historyLoading.value = false;
});
</script>
```

Changes:
- Removed `liked` ref and the `/api/music/user/liked` axios call
- Added auth-driven `userAvailable`, persisted `userSource`, and `currentUserPlaylists` computed
- Imports `Source` type and `SourceTabs` component

- [ ] **Step 4.3: Style — `.section-title` already supports inline children**

The existing `.section-title` style (Library.vue and Home.vue both) already uses `display: flex; align-items: center; gap: 8px;`. SourceTabs uses `display: inline-flex` with its own `margin-left`, so it sits inline with the title and count. **No style changes are required in either Home.vue or Library.vue.**

---

## Task 5: Verify the build and types

- [ ] **Step 5.1: Run TypeScript backend type check**

```
npx tsc --noEmit
```

Expected: exit code 0, no output. (No backend files were touched.)

- [ ] **Step 5.2: Run web type check + production build**

```
npm run build:web
```

Expected: build completes with `✓ built in N.NNs` and no TypeScript errors. The script runs `vue-tsc --noEmit && vite build`, so failures here mean a type or template error in our changes.

- [ ] **Step 5.3: Run the existing test suite to confirm no regression**

```
npm test
```

Expected: same baseline as before this feature (`Test Files 2 failed | 26 passed (28)`, `Tests 2 failed | 161 passed (163)`). The 2 pre-existing failures are in `dist/` and `.claude/worktrees/` and are unrelated to our changes — they should remain at exactly 2.

If any **source-tree** test fails (anything not in `dist/` or `.claude/worktrees/`), stop and investigate.

---

## Task 6: Manual smoke test on the dev server

This task verifies behavior the type system can't catch.

- [ ] **Step 6.1: Start the dev server**

```
npm run dev
```

Wait for `Web server started` and `WebUI: http://localhost:3000` log lines.

- [ ] **Step 6.2: Test scenario A — only NetEase logged in**

Open http://localhost:3000 in a browser. Confirm:

- 推荐歌单 section displays NetEase playlists, **no tab bar visible** (single source, SourceTabs auto-hidden)
- 每日推荐 section: visible only if NetEase login provides daily songs; **no tab bar**
- 我的歌单 section: visible if NetEase has user playlists; **no tab bar**
- Navigate to `/library`: 我的歌单 section: same — no tab bar, NetEase playlists shown

Open DevTools → Application → Local Storage → `localhost:3000` → `source-tabs` should be absent or `{}` (no clicks happened).

- [ ] **Step 6.3: Test scenario B — both NetEase and QQ logged in**

If QQ is not logged in, log in via Settings → QQ Music → 扫码登录.

Hard reload the browser (Cmd/Ctrl+Shift+R) to bypass the 5-min `lastFetchTime` cache.

Confirm:

- 推荐歌单: tab bar shows `[网易云] [QQ]`, NetEase active by default
- Click `QQ` — playlist grid switches to QQ data, no flicker (data already in store)
- Click `网易云` — back to NetEase
- Same for 每日推荐 and 我的歌单
- Navigate to `/library`, confirm 我的歌单 has its own tab bar with independent state
- Reload the page — Home tabs and Library tab persist their last-selected source independently

Check `localStorage['source-tabs']`: should contain JSON with up to 4 keys (`home.recommend`, `home.daily`, `home.user`, `library.user`).

- [ ] **Step 6.4: Test scenario C — fallback when persisted source becomes unavailable**

While logged into both:
1. On Home, switch 推荐歌单 to `QQ`. Confirm `localStorage['source-tabs']['home.recommend'] === 'qq'`.
2. Go to Settings → log out of QQ.
3. Hard-reload Home.

Confirm:
- 推荐歌单 tab bar disappears (only NetEase available)
- Grid shows NetEase playlists (graceful fallback via `recommendSourceSafe`)
- `localStorage['source-tabs']['home.recommend']` is **still `'qq'`** (preference preserved)
4. Log back into QQ → reload → 推荐歌单 grid is QQ again (preference restored)

- [ ] **Step 6.5: Test mobile layout**

Open DevTools → Toggle device toolbar → set width to 375px (iPhone SE).

Confirm on Home and Library:
- Section title + tab bar fit on the same line without overflow
- Tab buttons are at least 36px tall (use Inspect → check computed `min-height`)
- Tabs are tappable (clicking still switches sources)

- [ ] **Step 6.6: Stop the dev server**

Kill the `npm run dev` process.

---

## Task 7: Final commit

- [ ] **Step 7.1: Stage and commit Task 2 + 3 + 4 changes**

```
git add web/src/stores/player.ts web/src/stores/sourceTabs.ts web/src/views/Home.vue web/src/views/Library.vue
git status
```

Expected `git status` output: 4 modified/new files staged, working tree otherwise clean (apart from pre-existing `.claude/worktrees/` and `test-ts6-version.cjs` untracked).

```
git commit -m "feat(web): per-platform source tabs on Home and Library

Recommend playlists, daily songs, and user playlists on Home now show
a [网易云][QQ] tab when both platforms are logged in. Library 我的歌单
gets the same tab. Selection persists per-section in localStorage and
falls back gracefully when the persisted source becomes unavailable
(e.g., user logged out). Removes dead 我的收藏 block from Library that
referenced a non-existent /api/music/user/liked endpoint.

Spec: docs/superpowers/specs/2026-05-06-music-source-tabs-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7.2: Verify commit landed**

```
git log --oneline -3
```

Expected:
```
<sha> feat(web): per-platform source tabs on Home and Library
<sha> feat(web): add SourceTabs component for platform switcher
<sha> docs: spec for multi-source tabs on Home and Library
```

---

## Done

The branch should now have 3 new commits on top of the merge commit, all green builds and tests, and the feature working in dev mode.
