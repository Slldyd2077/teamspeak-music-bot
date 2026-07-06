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

      <div
        v-if="localAudioEnabled"
        class="local-upload"
        :class="{ dragging: isDragging, uploading }"
        @dragenter.prevent="isDragging = true"
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="handleDrop"
      >
        <Icon icon="mdi:tray-arrow-up" class="upload-icon" />
        <div class="upload-copy">
          <div class="upload-title">拖拽本地音频到这里上传</div>
          <div class="upload-subtitle">支持 mp3、flac、wav、m4a、ogg、opus、aac、webm 等格式，上传后可直接播放或加入队列</div>
        </div>
        <button class="upload-btn" :disabled="uploading" @click="fileInput?.click()">
          {{ uploading ? '上传中...' : '选择音频' }}
        </button>
        <input
          ref="fileInput"
          class="file-input"
          type="file"
          multiple
          accept="audio/*,.mp3,.flac,.wav,.m4a,.aac,.ogg,.opus,.webm,.wma,.alac,.aiff,.ape"
          @change="handleFileSelect"
        />
      </div>
      <div v-else class="local-upload disabled">
        <Icon icon="mdi:music-off" class="upload-icon" />
        <div class="upload-copy">
          <div class="upload-title">本地音频播放已关闭</div>
          <div class="upload-subtitle">管理员可在「设置 → 行为设置 → 本地音频播放」中开启。</div>
        </div>
      </div>
      <div v-if="uploadMessage" class="upload-message" :class="uploadMessageType">{{ uploadMessage }}</div>
    </div>

    <div v-if="loading" class="loading">搜索中...</div>

    <template v-else-if="allSongs.length || allAlbums.length || allPlaylists.length">
      <div class="source-bar">
        <button
          class="source-btn"
          :class="{ active: selectedSource === 'netease' }"
          @click="selectedSource = 'netease'"
        >网易云</button>
        <button
          class="source-btn"
          :class="{ active: selectedSource === 'qq' }"
          @click="selectedSource = 'qq'"
        >QQ</button>
        <button
          class="source-btn"
          :class="{ active: selectedSource === 'bilibili' }"
          @click="selectedSource = 'bilibili'"
        >B站</button>
        <button
          class="source-btn"
          :class="{ active: selectedSource === 'kugou' }"
          @click="selectedSource = 'kugou'"
        >酷狗</button>
        <button
          v-if="hasLocalSongs"
          class="source-btn"
          :class="{ active: selectedSource === 'local' }"
          @click="selectedSource = 'local'"
        >本地</button>
      </div>

      <div class="tab-bar">
        <button
          class="tab"
          :class="{ active: activeTab === 'songs' }"
          @click="activeTab = 'songs'"
        >
          单曲<span class="tab-count">{{ filteredSongs.length }}</span>
        </button>
        <button
          v-if="selectedSource !== 'bilibili' && selectedSource !== 'local' && selectedSource !== 'kugou'"
          class="tab"
          :class="{ active: activeTab === 'albums' }"
          @click="activeTab = 'albums'"
        >
          专辑<span class="tab-count">{{ filteredAlbums.length }}</span>
        </button>
        <button
          v-if="selectedSource !== 'bilibili' && selectedSource !== 'local' && selectedSource !== 'kugou'"
          class="tab"
          :class="{ active: activeTab === 'playlists' }"
          @click="activeTab = 'playlists'"
        >
          歌单<span class="tab-count">{{ filteredPlaylists.length }}</span>
        </button>
      </div>

      <section v-if="activeTab === 'albums' && filteredAlbums.length" class="result-section">
        <div class="card-grid">
          <router-link
            v-for="al in filteredAlbums"
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

      <section v-if="activeTab === 'playlists' && filteredPlaylists.length" class="result-section">
        <div class="card-grid">
          <router-link
            v-for="pl in filteredPlaylists"
            :key="`${pl.platform}-${pl.id}`"
            :to="`/playlist/${pl.id}?platform=${pl.platform}`"
            class="card hover-scale"
          >
            <CoverArt :url="pl.coverUrl" :size="160" :radius="10" :show-shadow="true" />
            <button
              class="fav-badge"
              :class="{ favorited: isFav(pl) }"
              @click.prevent.stop="toggleFavPlaylist(pl)"
            >
              <Icon :icon="isFav(pl) ? 'mdi:heart' : 'mdi:heart-outline'" />
            </button>
            <div class="card-name">
              {{ pl.name }}
              <span class="platform-badge" :class="badgeClass(pl.platform)">{{ badgeLabel(pl.platform) }}</span>
            </div>
          </router-link>
        </div>
      </section>

      <section v-if="activeTab === 'songs' && filteredSongs.length" class="result-section">
        <SongCard
          v-for="(song, i) in filteredSongs"
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
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';
import type { Song } from '../stores/player.js';
import SongCard from '../components/SongCard.vue';
import CoverArt from '../components/CoverArt.vue';

const store = usePlayerStore();
const route = useRoute();
const router = useRouter();

const SOURCE_STORAGE_KEY = 'search-source';

type SearchSource = 'netease' | 'qq' | 'bilibili' | 'local' | 'kugou';

function loadSource(): SearchSource {
  try {
    const stored = localStorage.getItem(SOURCE_STORAGE_KEY);
    if (stored === 'netease' || stored === 'qq' || stored === 'bilibili' || stored === 'local' || stored === 'kugou') return stored;
  } catch { /* localStorage blocked */ }
  return 'netease';
}

const query = ref((route.query.q as string) || '');
const activeTab = ref<'songs' | 'albums' | 'playlists'>('songs');
const selectedSource = ref<SearchSource>(loadSource());

interface Album { id: string; name: string; artist: string; coverUrl: string; songCount?: number; platform: string; }
interface Playlist { id: string; name: string; coverUrl: string; songCount?: number; platform: string; }

const allSongs = ref<Song[]>([]);
const allAlbums = ref<Album[]>([]);
const allPlaylists = ref<Playlist[]>([]);
const loading = ref(false);
const searched = ref(false);
const uploading = ref(false);
const isDragging = ref(false);
const uploadMessage = ref('');
const uploadMessageType = ref<'info' | 'error'>('info');
const fileInput = ref<HTMLInputElement | null>(null);
const localAudioEnabled = ref(true);

const filteredSongs = computed(() =>
  allSongs.value.filter((s) => s.platform === selectedSource.value)
);

const filteredAlbums = computed(() =>
  allAlbums.value.filter((a) => a.platform === selectedSource.value)
);

const filteredPlaylists = computed(() =>
  allPlaylists.value.filter((p) => p.platform === selectedSource.value)
);

const hasLocalSongs = computed(() => localAudioEnabled.value && allSongs.value.some((s) => s.platform === 'local'));

// Persist source preference
watch(selectedSource, (src) => {
  try { localStorage.setItem(SOURCE_STORAGE_KEY, src); } catch { /* ignore */ }
});

// B站 / 本地上传没有专辑和歌单页签，切换时强制回到单曲。
watch(selectedSource, (src) => {
  if ((src === 'bilibili' || src === 'local' || src === 'kugou') && activeTab.value !== 'songs') {
    activeTab.value = 'songs';
  }
});

function isFav(pl: { id: string; platform: string }): boolean {
  return store.isFavorited(pl.id, pl.platform);
}

async function toggleFavPlaylist(pl: { id: string; platform: string; name: string; coverUrl: string; songCount?: number }) {
  if (isFav(pl)) {
    const fav = store.favoritedPlaylists.find((f) => f.playlistId === pl.id && f.platform === pl.platform);
    if (fav) await store.removeFavorite(fav.id);
  } else {
    await store.addFavorite({
      platform: pl.platform,
      playlistId: pl.id,
      name: pl.name,
      coverUrl: pl.coverUrl,
      songCount: pl.songCount ?? 0,
    });
  }
}

async function doSearch() {
  if (!query.value.trim()) return;
  loading.value = true;
  searched.value = true;
  activeTab.value = 'songs';
  router.replace({ query: { q: query.value } });
  try {
    const res = await axios.get('/api/music/search/all', { params: { q: query.value, botId: store.activeBotId ?? undefined } });
    allSongs.value = res.data.songs ?? [];
    allAlbums.value = res.data.albums ?? [];
    allPlaylists.value = res.data.playlists ?? [];
  } catch {
    allSongs.value = []; allAlbums.value = []; allPlaylists.value = [];
  } finally {
    loading.value = false;
  }
}


function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || /\.(mp3|flac|wav|m4a|aac|ogg|opus|webm|wma|alac|aiff|ape)$/i.test(file.name);
}

async function uploadLocalFiles(fileList: File[]) {
  if (!localAudioEnabled.value) {
    uploadMessageType.value = 'error';
    uploadMessage.value = '本地音频播放已关闭';
    return;
  }
  const files = fileList.filter(isAudioFile);
  if (files.length === 0) {
    uploadMessageType.value = 'error';
    uploadMessage.value = '没有找到可上传的音频文件';
    return;
  }

  uploading.value = true;
  uploadMessageType.value = 'info';
  uploadMessage.value = `正在上传 ${files.length} 个文件...`;

  const uploaded: Song[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      const res = await axios.post('/api/music/local/upload', file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        maxBodyLength: Infinity,
      });
      if (res.data?.song) uploaded.push(res.data.song as Song);
    } catch (err: any) {
      failed.push(`${file.name}: ${err?.response?.data?.error || '上传失败'}`);
    }
  }

  if (uploaded.length > 0) {
    const uploadedKeys = new Set(uploaded.map((s) => `${s.platform}-${s.id}`));
    allSongs.value = [
      ...uploaded,
      ...allSongs.value.filter((s) => !uploadedKeys.has(`${s.platform}-${s.id}`)),
    ];
    selectedSource.value = 'local';
    activeTab.value = 'songs';
    searched.value = true;
    uploadMessageType.value = failed.length ? 'error' : 'info';
    uploadMessage.value = failed.length
      ? `已上传 ${uploaded.length} 个，失败 ${failed.length} 个：${failed[0]}`
      : `已上传 ${uploaded.length} 个本地音频`;
  } else {
    uploadMessageType.value = 'error';
    uploadMessage.value = failed[0] || '上传失败';
  }

  uploading.value = false;
}

function handleDrop(event: DragEvent) {
  isDragging.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  uploadLocalFiles(files);
}

function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  uploadLocalFiles(Array.from(input.files ?? []));
  input.value = '';
}

function badgeLabel(platform: string): string {
  if (platform === 'qq') return 'QQ';
  if (platform === 'bilibili') return 'B站';
  if (platform === 'youtube') return 'YouTube';
  if (platform === 'local') return '本地';
  if (platform === 'kugou') return '酷狗';
  return '网易云';
}

function badgeClass(platform: string): string {
  if (platform === 'qq') return 'badge-qq';
  if (platform === 'bilibili') return 'badge-bilibili';
  if (platform === 'youtube') return 'badge-youtube';
  if (platform === 'local') return 'badge-local';
  if (platform === 'kugou') return 'badge-kugou';
  return 'badge-netease';
}

async function loadLocalAudioSetting() {
  try {
    const res = await axios.get('/api/bot/settings');
    localAudioEnabled.value = res.data.localAudioEnabled ?? true;
    if (!localAudioEnabled.value && selectedSource.value === 'local') {
      selectedSource.value = 'netease';
    }
  } catch {
    // Guests may not be allowed to read settings; backend still enforces the switch.
  }
}

onMounted(() => {
  loadLocalAudioSetting();
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

.local-upload {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-card);
  transition: border-color var(--transition-fast), background var(--transition-fast), transform var(--transition-fast);

  &.dragging {
    border-color: var(--color-primary);
    background: var(--color-primary-10);
    transform: translateY(-1px);
  }

  &.uploading {
    opacity: 0.8;
  }
}

.upload-icon {
  flex-shrink: 0;
  font-size: 28px;
  color: var(--color-primary);
}

.upload-copy {
  flex: 1;
  min-width: 0;
}

.upload-title {
  font-size: 14px;
  font-weight: var(--fw-semi);
  color: var(--text-primary);
}

.upload-subtitle {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.4;
}

.upload-btn {
  flex-shrink: 0;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: #fff;
  font-size: 13px;
  font-weight: var(--fw-semi);
  cursor: pointer;

  &:disabled {
    cursor: not-allowed;
    opacity: 0.65;
  }
}

.file-input {
  display: none;
}

.local-upload.disabled {
  opacity: 0.65;
  border-style: solid;
}

.upload-message {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);

  &.error {
    color: #e74c3c;
  }
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

.source-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.source-btn {
  padding: 5px 16px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-family: inherit;
  font-weight: var(--fw-semi);
  color: var(--text-secondary);
  background: var(--bg-card);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;

  &:hover { color: var(--text-primary); }

  &.active {
    color: var(--color-primary);
    background: rgba(51, 94, 234, 0.12);
  }
}

.tab-bar {
  display: flex;
  gap: 6px;
  margin-bottom: 24px;
  padding: 4px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  width: fit-content;
}

.tab {
  padding: 8px 20px;
  border-radius: calc(var(--radius-md) - 2px);
  font-size: 14px;
  font-family: inherit;
  font-weight: var(--fw-semi);
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;

  &:hover { color: var(--text-primary); }

  &.active {
    background: var(--color-primary);
    color: #fff;
    .tab-count { opacity: 0.85; }
  }
}

.tab-count {
  margin-left: 5px;
  opacity: 0.55;
  font-weight: var(--fw-regular);
  font-size: 13px;

  &::before { content: '('; }
  &::after  { content: ')'; }
}

.result-section {
  margin-bottom: 32px;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px 28px;
}
.card {
  position: relative;
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

.badge-local {
  background: var(--color-primary-10);
  color: var(--color-primary);
}

.badge-kugou {
  background: var(--brand-kugou-12);
  color: var(--brand-kugou);
}

.fav-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  color: rgba(255, 255, 255, 0.7);
  font-size: 16px;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast);
  z-index: 2;

  .card:hover & {
    opacity: 1;
  }

  &.favorited {
    color: #e74c3c;
    opacity: 1;
  }

  &:hover {
    color: #e74c3c;
    background: rgba(0, 0, 0, 0.7);
  }
}
</style>
