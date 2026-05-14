<template>
  <div class="search-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      返回
    </button>
    <div class="search-header">
      <div class="search-input-wrap">
        <Icon icon="mdi:magnify" class="search-icon" />
        <input
          ref="searchInput"
          v-model="query"
          class="search-input"
          placeholder="搜索歌曲、歌手、专辑..."
          @keyup.enter="doSearch"
          autofocus
        />
      </div>
    </div>

    <div v-if="loading" class="loading">搜索中...</div>

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
            <div class="card-name">
              {{ al.name }}
              <span class="platform-badge" :class="badgeClass(al.platform)">{{ badgeLabel(al.platform) }}</span>
            </div>
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
            <div class="card-name">
              {{ pl.name }}
              <span class="platform-badge" :class="badgeClass(pl.platform)">{{ badgeLabel(pl.platform) }}</span>
            </div>
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';
import type { Song } from '../stores/player.js';
import SongCard from '../components/SongCard.vue';
import CoverArt from '../components/CoverArt.vue';

const store = usePlayerStore();
const route = useRoute();

const query = ref((route.query.q as string) || '');

interface Album { id: string; name: string; artist: string; coverUrl: string; songCount?: number; platform: string; }
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

function badgeLabel(platform: string): string {
  if (platform === 'qq') return 'QQ';
  if (platform === 'bilibili') return 'B站';
  if (platform === 'youtube') return 'YouTube';
  return '网易云';
}

function badgeClass(platform: string): string {
  if (platform === 'qq') return 'badge-qq';
  if (platform === 'bilibili') return 'badge-bilibili';
  if (platform === 'youtube') return 'badge-youtube';
  return 'badge-netease';
}

onMounted(() => {
  if (query.value) doSearch();
});
</script>

<style lang="scss" scoped>
.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  opacity: 0.7;
  margin-bottom: 16px;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
}

.search-header {
  margin-bottom: 24px;
}

.search-input-wrap {
  display: flex;
  align-items: center;
  padding: 14px 20px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  margin-bottom: 16px;
}

.search-icon {
  font-size: 22px;
  opacity: 0.4;
  margin-right: 12px;
}

.search-input {
  flex: 1;
  border: none;
  background: none;
  outline: none;
  font-size: 16px;
  font-family: inherit;
  color: var(--text-primary);

  &::placeholder {
    color: var(--text-tertiary);
  }
}

.loading {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}

.empty {
  text-align: center;
  padding: 60px;
  color: var(--text-tertiary);
  font-size: 14px;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

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

.platform-badge {
  vertical-align: middle;
  flex-shrink: 0;
  font-size: var(--fs-micro);
  font-weight: var(--fw-semi);
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  line-height: 1.4;
}

.badge-netease {
  background: var(--brand-netease-15);
  color: var(--brand-netease);
}

.badge-qq {
  background: var(--brand-qq-15);
  color: var(--brand-qq);
}

.badge-bilibili {
  background: var(--brand-bilibili-15);
  color: var(--brand-bilibili);
}

.badge-youtube {
  background: var(--brand-youtube-12);
  color: var(--brand-youtube);
}
</style>
