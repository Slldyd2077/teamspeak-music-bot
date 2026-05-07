# Album Search & Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface albums in search results and allow playing the whole album from the web UI. Currently `SearchResult.albums` is always `[]` and Search.vue only renders songs.

**Architecture:** Extend `search()` in netease + qq providers to populate `albums`. Aggregate them in `/search/all`. Add a new "专辑" (and "歌单") section to Search.vue. Reuse `Playlist.vue` as the album detail page by branching on `route.meta.kind` between `/playlist/:id` and `/album/:id` endpoints. The existing `getAlbumSongs(id)` and `/api/music/album/:id` endpoint already work.

**Tech Stack:** Node 20 + TS, Express 5, Vue 3 + Vue Router 4, axios. No new deps.

---

## Spec Reference

`docs/superpowers/specs/2026-05-07-custom-avatar-and-album-search-design.md` — section "专辑搜索".

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/music/provider.ts` | Read-only | Verify `Album` and `SearchResult.albums` shape (no change expected) |
| `src/music/netease.ts` | Modify | `search()` adds a third parallel call (`type=10`) and maps albums |
| `src/music/qq.ts` | Modify | `search()` adds `req_album` section and maps albums |
| `src/music/netease.test.ts` | Modify | New tests for albums in search response |
| `src/music/qq.test.ts` | Modify (or create if absent) | Tests for albums in qq search |
| `src/web/api/music.ts` | Modify | `/search/all` returns `{songs, albums, playlists}` |
| `web/src/views/Search.vue` | Modify | Render albums + playlists sections |
| `web/src/views/Playlist.vue` | Modify | Branch endpoint by `route.meta.kind === 'album'` |
| `web/src/router/index.ts` | Modify | Add `/album/:id` route reusing Playlist component, set `meta.kind = 'album'` |

## Conventions

- TDD throughout. Each task: failing test → implement → verify → commit.
- Mock HTTP via existing fixtures pattern (look at `src/music/netease.test.ts` for setup).
- Keep all platform-specific quirks inside the provider class — no leaking into Search.vue logic.

---

### Task 1: netease.ts — fetch albums in search

**Files:**
- Modify: `src/music/netease.ts`
- Modify: `src/music/netease.test.ts`

- [ ] **Step 1: Read the existing test setup so we mock the same way**

```bash
grep -n 'cloudsearch\|MockAdapter\|axios.create\|mock\|nock\|fixture' src/music/netease.test.ts | head -20
```

- [ ] **Step 2: Write the failing test**

Append to `src/music/netease.test.ts` inside the existing `describe`:

```ts
  it("populates SearchResult.albums from cloudsearch type=10", async () => {
    // Adjust the fixture/mock helper to your existing test pattern.
    // The test should: arrange a mock that returns a non-empty albums array
    // for type=10, run search(), assert result.albums has the expected shape.
    mockApi.onGet("/cloudsearch", { params: expect.objectContaining({ type: 10 }) }).reply(200, {
      result: {
        albums: [
          { id: 42, name: "Album A", picUrl: "https://x/p.jpg", artists: [{ name: "Artist X" }] },
        ],
      },
    });
    mockApi.onGet("/cloudsearch", { params: expect.objectContaining({ type: 1 }) }).reply(200, { result: { songs: [] } });
    mockApi.onGet("/cloudsearch", { params: expect.objectContaining({ type: 1000 }) }).reply(200, { result: { playlists: [] } });

    const provider = makeProvider();
    const r = await provider.search("foo", 5);
    expect(r.albums).toEqual([
      { id: "42", name: "Album A", artist: "Artist X", coverUrl: "https://x/p.jpg", platform: "netease" },
    ]);
  });
```

If the existing tests use a different mock library (e.g. `msw` or manual axios stubbing), translate the fixture above to match. Do not introduce new test deps.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/music/netease.test.ts`
Expected: FAIL — `result.albums` is `[]`

- [ ] **Step 4: Implement the change**

In `src/music/netease.ts` `search()` (~line 93), change the `Promise.all` from 2 to 3 calls:

```ts
const [songRes, playlistRes, albumRes] = await Promise.all([
  this.api.get("/cloudsearch", { params: { keywords: query, type: 1, limit, ...this.cookieParams } }),
  this.api.get("/cloudsearch", { params: { keywords: query, type: 1000, limit: 5, ...this.cookieParams } }),
  this.api.get("/cloudsearch", { params: { keywords: query, type: 10, limit: 5, ...this.cookieParams } }),
]);
```

After the existing `playlists: Playlist[] = ...` mapping, add:

```ts
const albums: Album[] = (albumRes.data?.result?.albums ?? []).map((a: any) => ({
  id: String(a.id),
  name: a.name ?? "",
  artist: (a.artists ?? []).map((x: any) => x.name).join(" / "),
  coverUrl: a.picUrl ?? "",
  platform: "netease",
}));
```

Update the `return { songs, playlists, albums: [] }` to `return { songs, playlists, albums }`.

(Make sure `Album` is imported from `./provider.js`; if not yet imported, add it to the existing import.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/music/netease.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/music/netease.ts src/music/netease.test.ts
git commit -m "feat(netease): include albums in search results"
```

---

### Task 2: qq.ts — fetch albums in search

**Files:**
- Modify: `src/music/qq.ts`
- Modify or Create: `src/music/qq.test.ts`

- [ ] **Step 1: Verify whether qq.test.ts exists**

```bash
ls src/music/qq.test.ts
```

If absent, create a minimal one mirroring `netease.test.ts` style: instantiate provider, mock the `qqDirectApi` axios instance, assert `r.albums.length > 0` after a `search()` call.

- [ ] **Step 2: Write the failing test**

Add to `src/music/qq.test.ts`:

```ts
it("populates SearchResult.albums from a parallel album search request", async () => {
  // Mock returns an album list under req_album.data.body.album.list
  mockApi.onGet("/cgi-bin/musicu.fcg").reply((cfg) => {
    const data = JSON.parse(cfg.params?.data ?? "{}");
    if (data.req_album) {
      return [200, { req_album: { data: { body: { album: { list: [
        { albumMID: "abc", albumName: "Aero", singerName: "S", albumPic: "https://x/p.jpg" },
      ] } } } } }];
    }
    if (data.req_0) {
      return [200, { req_0: { data: { body: { song: { list: [] } } } } }];
    }
    return [200, {}];
  });

  const provider = makeProvider();
  const r = await provider.search("foo", 5);
  expect(r.albums).toEqual([
    { id: "abc", name: "Aero", artist: "S", coverUrl: expect.stringContaining("https://"), platform: "qq" },
  ]);
});
```

Verify the actual QQ API response shape against a real call before finalizing the field names — `albumMID` vs `mid`, `albumPic` vs `pic`, etc. If unsure, log a real response once and freeze the shape in the fixture.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/music/qq.test.ts`
Expected: FAIL — `r.albums` is `[]`

- [ ] **Step 4: Implement the change**

In `src/music/qq.ts` `search()` (~line 63), change `reqData` to include both `req_0` (songs) and `req_album` (albums):

```ts
const reqData = JSON.stringify({
  req_0: {
    module: "music.search.SearchCgiService",
    method: "DoSearchForQQMusicDesktop",
    param: { searchid: "1", query, num_per_page: Math.min(limit, 50), search_type: 0 },
  },
  req_album: {
    module: "music.search.SearchCgiService",
    method: "DoSearchForQQMusicDesktop",
    param: { searchid: "1", query, num_per_page: 5, search_type: 8 },
  },
});
```

After the existing `songs` mapping, add:

```ts
const albumList: any[] = res.data?.req_album?.data?.body?.album?.list ?? [];
const albums: Album[] = albumList.map((a: any) => ({
  id: String(a.albumMID ?? a.mid ?? a.albumID ?? ""),
  name: a.albumName ?? a.title ?? "",
  artist: a.singerName ?? (a.singer ?? []).map((s: any) => s.name).join(" / "),
  coverUrl: a.albumMID
    ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${a.albumMID}.jpg`
    : (a.albumPic ?? ""),
  platform: "qq",
}));
```

Change `return { songs, playlists: [], albums: [] }` to `return { songs, playlists: [], albums }`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/music/qq.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/music/qq.ts src/music/qq.test.ts
git commit -m "feat(qq): include albums in search results"
```

---

### Task 3: /search/all — aggregate albums + playlists

**Files:**
- Modify: `src/web/api/music.ts`

- [ ] **Step 1: Look at the current aggregation**

In `src/web/api/music.ts` near line 40 the `/search/all` handler builds only `songs`. Extend it.

- [ ] **Step 2: Write a failing integration test (if test infra allows)**

If there's already a test file for music.ts, add a test that mocks the providers and asserts `res.body.albums.length > 0`. If not, skip and rely on Task 1+2 unit coverage + manual verification in Task 4.

- [ ] **Step 3: Aggregate albums + playlists**

Replace the existing `songs = ...` block + `res.json({ songs })` at lines ~54–62 with:

```ts
const songs = [
  ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.songs : []),
  ...(qqResult.status === "fulfilled" ? qqResult.value.songs : []),
  ...(bilibiliResult.status === "fulfilled" ? bilibiliResult.value.songs : []),
];
const albums = [
  ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.albums : []),
  ...(qqResult.status === "fulfilled" ? qqResult.value.albums : []),
];
const playlists = [
  ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.playlists : []),
  ...(qqResult.status === "fulfilled" ? qqResult.value.playlists : []),
];

res.json({ songs, albums, playlists });
```

(Bilibili intentionally skipped for albums/playlists — no album concept; playlists likewise minor.)

- [ ] **Step 4: Verify by curl**

Build + run, then:

```bash
curl -s 'http://localhost:3000/api/music/search/all?q=Beyond' \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print({k: len(v) for k, v in d.items()})'
```

Expected: `{'songs': N>0, 'albums': N>0, 'playlists': N>=0}`

- [ ] **Step 5: Commit**

```bash
git add src/web/api/music.ts
git commit -m "feat(api): /search/all returns albums and playlists"
```

---

### Task 4: Album route reusing Playlist.vue

**Files:**
- Modify: `web/src/router/index.ts`
- Modify: `web/src/views/Playlist.vue`

- [ ] **Step 1: Look at the current router config and Playlist load logic**

```bash
grep -n "path:\|component:\|meta" web/src/router/index.ts
grep -n "loadPlaylist\|/api/music/playlist\|onMounted" web/src/views/Playlist.vue
```

- [ ] **Step 2: Add /album/:id route**

In `web/src/router/index.ts`, find the `/playlist/:id` route entry. Right after it, add:

```ts
  {
    path: '/album/:id',
    component: () => import('../views/Playlist.vue'),
    meta: { kind: 'album' },
  },
```

(If `/playlist/:id` is `meta:`-less, also add `meta: { kind: 'playlist' }` to it for symmetry.)

- [ ] **Step 3: Branch the endpoint inside Playlist.vue**

Find the load function (probably `onMounted(async () => { axios.get('/api/music/playlist/' + id, ...) })`). Refactor:

```ts
const route = useRoute();
const kind = (route.meta.kind as string) ?? 'playlist'; // 'playlist' | 'album'
const endpoint = kind === 'album' ? '/api/music/album/' : '/api/music/playlist/';
// ... use `${endpoint}${route.params.id}` ...
```

For the hero metadata, the playlist endpoint returns `{songs}` only (no top-level cover/title) — verify what the Album endpoint currently returns. If both only return `{songs}`, the existing Playlist.vue must already derive the cover from somewhere (probably the first song's coverUrl, or an additional `/api/music/playlist/:id/detail` call). Keep the existing pattern; if a separate detail call is needed for albums, fetch the metadata from `/api/music/song/<firstSong.id>` to get the album name + cover, OR add a thin `/api/music/album/:id/detail` endpoint that returns `{ name, coverUrl, description }`.

**Decision:** if Playlist.vue currently uses ONLY `/api/music/playlist/:id` and derives metadata from songs, do the same for albums (no new endpoint). If it calls a separate detail endpoint, add a matching `/api/music/album/:id/detail` returning `{ name, coverUrl }` from the first song's `album` and `coverUrl` fields.

- [ ] **Step 4: Verify in browser**

Run `cd web && npm run dev`. Visit `/album/<some-netease-album-id>` (pick one from a search). Expect: hero header + song list + play-all button — same UX as a playlist page.

- [ ] **Step 5: Commit**

```bash
git add web/src/router/index.ts web/src/views/Playlist.vue
git commit -m "feat(web): /album/:id route reusing Playlist view"
```

---

### Task 5: Search.vue — render albums + playlists sections

**Files:**
- Modify: `web/src/views/Search.vue`

- [ ] **Step 1: Read current Search.vue**

```bash
sed -n '1,120p' web/src/views/Search.vue
```

Identify: the `results.value = res.data.songs` line and the `<div v-else-if="results.length > 0">` block.

- [ ] **Step 2: Refactor to three result lists**

Replace the script:

```ts
import type { Song } from '../stores/player.js';

interface Album { id: string; name: string; artist: string; coverUrl: string; platform: string; }
interface Playlist { id: string; name: string; coverUrl: string; songCount?: number; platform: string; }

const songs = ref<Song[]>([]);
const albums = ref<Album[]>([]);
const playlists = ref<Playlist[]>([]);
const loading = ref(false);
const searched = ref(false);

async function doSearch() {
  if (!query.value.trim()) return;
  loading.value = true;
  searched.value = true;
  try {
    const res = await axios.get('/api/music/search/all', { params: { q: query.value } });
    songs.value = res.data.songs ?? [];
    albums.value = res.data.albums ?? [];
    playlists.value = res.data.playlists ?? [];
  } catch {
    songs.value = []; albums.value = []; playlists.value = [];
  } finally {
    loading.value = false;
  }
}
```

- [ ] **Step 3: Render the sections**

Replace the existing `<div v-else-if="results.length > 0" class="results">` block:

```vue
    <template v-else-if="songs.length || albums.length || playlists.length">
      <section v-if="albums.length" class="result-section">
        <h2 class="section-title">专辑</h2>
        <div class="card-grid">
          <router-link
            v-for="al in albums"
            :key="`${al.platform}-${al.id}`"
            :to="`/album/${al.id}?platform=${al.platform}`"
            class="card hover-scale"
          >
            <CoverArt :url="al.coverUrl" :size="160" :radius="10" :show-shadow="true" />
            <div class="card-name">{{ al.name }}</div>
            <div class="card-sub">{{ al.artist }}</div>
          </router-link>
        </div>
      </section>

      <section v-if="playlists.length" class="result-section">
        <h2 class="section-title">歌单</h2>
        <div class="card-grid">
          <router-link
            v-for="pl in playlists"
            :key="`${pl.platform}-${pl.id}`"
            :to="`/playlist/${pl.id}?platform=${pl.platform}`"
            class="card hover-scale"
          >
            <CoverArt :url="pl.coverUrl" :size="160" :radius="10" :show-shadow="true" />
            <div class="card-name">{{ pl.name }}</div>
          </router-link>
        </div>
      </section>

      <section v-if="songs.length" class="result-section">
        <h2 class="section-title">单曲</h2>
        <SongCard
          v-for="(song, i) in songs"
          :key="`${song.platform}-${song.id}`"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @play="store.playSong(song)"
          @playNext="store.playNextSong(song)"
          @add="store.addSong(song)"
        />
      </section>
    </template>

    <div v-else-if="searched" class="empty">未找到相关结果</div>
```

(Import `CoverArt`: `import CoverArt from '../components/CoverArt.vue';`.)

- [ ] **Step 4: Add minimal styles**

Append to the `<style lang="scss" scoped>` block:

```scss
.result-section {
  margin-bottom: 32px;
  .section-title { font-size: 18px; margin: 0 0 12px; opacity: 0.85; }
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-decoration: none;
  color: inherit;
  .card-name { font-size: 14px; line-height: 1.3; max-height: 2.6em; overflow: hidden; }
  .card-sub  { font-size: 12px; opacity: 0.6; }
}
```

- [ ] **Step 5: Build + visually verify**

```bash
cd web && npm run build
```

Then `npm run dev` → search "周杰伦" → see three sections; click an album card → arrives at `/album/:id` with songs + play-all.

- [ ] **Step 6: Commit**

```bash
git add web/src/views/Search.vue
git commit -m "feat(web): show album + playlist sections in search"
```

---

### Task 6: Open PR

- [ ] **Step 1: Push branch**

```bash
git checkout -b feat/album-search
git push -u origin feat/album-search
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --title "feat(search): album section + album playback" --body "Closes part of #51 (album half).

## Summary
- netease.search() / qq.search() now populate SearchResult.albums
- /api/music/search/all returns albums + playlists alongside songs
- Search.vue renders three sections: 专辑 / 歌单 / 单曲
- /album/:id route reuses Playlist.vue with meta.kind='album'
- bilibili / youtube intentionally still return albums:[] (no album API)

## Test plan
- [x] vitest covers netease + qq search returning non-empty albums
- [x] curl /search/all?q=周杰伦 returns {songs, albums, playlists}
- [x] Manual: search → click album card → /album/:id → play all

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review Checklist

- [x] Spec coverage: backend album search → Tasks 1+2; aggregator → Task 3; album detail route → Task 4; UI sections → Task 5
- [x] No "TBD"/placeholder text — every step shows the actual diff or command
- [x] Type names consistent: `Album` (capital A), `albums` (lowercase plural), `SearchResult.albums`
- [x] Bilibili/YouTube explicitly out of scope per spec — confirmed in Task 3 by skipping them in albums aggregation
- [x] Routes use `meta.kind` — same key referenced in Playlist.vue (Task 4) and `/album/:id` registration (Task 4 Step 2)
