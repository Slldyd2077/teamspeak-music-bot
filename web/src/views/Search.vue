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

    <div v-else-if="results.length > 0" class="results">
      <SongCard
        v-for="(song, i) in results"
        :key="`${song.platform}-${song.id}`"
        :song="song"
        :index="i + 1"
        :active="store.currentSong?.id === song.id"
        @play="store.playSong(song)"
        @playNext="store.playNextSong(song)"
        @add="store.addSong(song)"
      />
    </div>

    <div v-else-if="searched" class="empty">
      未找到相关结果
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';
import SongCard from '../components/SongCard.vue';

const store = usePlayerStore();
const route = useRoute();

const query = ref((route.query.q as string) || '');
import { Song } from '../stores/player.js';

const results = ref<Song[]>([]);
const loading = ref(false);
const searched = ref(false);

async function doSearch() {
  if (!query.value.trim()) return;
  loading.value = true;
  searched.value = true;
  try {
    const res = await axios.get('/api/music/search/all', {
      params: { q: query.value },
    });
    results.value = res.data.songs;
  } catch {
    results.value = [];
  } finally {
    loading.value = false;
  }
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
</style>
