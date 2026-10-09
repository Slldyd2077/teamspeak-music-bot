<template>
  <div class="artist-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      返回
    </button>

    <div v-if="loading" class="loading">加载中...</div>

    <template v-else-if="artist">
      <!-- Hero: Apple Music style — round portrait, then name / meta / actions. -->
      <div class="artist-hero">
        <div class="artist-portrait-wrap">
          <img
            v-if="artist.avatarUrl"
            class="artist-portrait"
            :src="artist.avatarUrl"
            :alt="artist.name"
            referrerpolicy="no-referrer"
          />
          <div v-else class="artist-portrait artist-portrait-fallback">
            <Icon icon="mdi:account-music" />
          </div>
        </div>
        <div class="artist-meta">
          <div class="artist-platform">{{ platformLabel }}</div>
          <h1 class="artist-title">{{ artist.name }}</h1>
          <div v-if="artist.aliases?.length" class="artist-aliases">
            {{ artist.aliases.join(' / ') }}
          </div>
          <div class="artist-stats">
            <span v-if="hotSongs.length">热门歌曲 {{ hotSongs.length }} 首</span>
            <span v-if="albums.length">专辑 {{ albums.length }} 张</span>
            <span v-if="artist.songCount">共 {{ artist.songCount }} 首歌</span>
          </div>
          <p v-if="artist.description" class="artist-desc">{{ artist.description }}</p>
          <div class="artist-actions">
            <button
              v-if="canPlayAll"
              class="play-all-btn"
              :disabled="!artist"
              title="播放该歌手的全部歌曲"
              @click="playAll"
            >
              <Icon icon="mdi:play" />
              播放
            </button>
            <button
              v-if="canShuffle"
              class="shuffle-btn"
              :disabled="!artist"
              title="随机播放该歌手的全部歌曲"
              @click="shuffleAll"
            >
              <Icon icon="mdi:shuffle" />
              随机播放
            </button>
          </div>
        </div>
      </div>

      <section v-if="hotSongs.length" class="artist-section">
        <h2 class="section-title">热门歌曲</h2>
        <div class="song-list">
          <SongCard
            v-for="(song, i) in visibleSongs"
            :key="song.id"
            :song="song"
            :index="i + 1"
            :active="store.currentSong?.id === song.id"
            @play="store.playSong(song)"
            @playNext="store.playNextSong(song)"
            @add="store.addSong(song)"
          />
        </div>
        <button v-if="hotSongs.length > visibleCount" class="more-btn" @click="expanded = true">
          显示全部 {{ hotSongs.length }} 首
        </button>
      </section>

      <section v-if="albums.length" class="artist-section">
        <h2 class="section-title">专辑</h2>
        <div class="album-row">
          <router-link
            v-for="al in albums"
            :key="al.id"
            :to="`/album/${al.id}?platform=${al.platform}`"
            class="album-card hover-scale"
          >
            <CoverArt :url="al.coverUrl" :size="150" :radius="10" :show-shadow="true" />
            <div class="album-name">{{ al.name }}</div>
            <div v-if="al.songCount" class="album-sub">{{ al.songCount }} 首</div>
          </router-link>
        </div>
      </section>
    </template>

    <div v-else class="loading">歌手不存在或加载失败</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore, type Song } from '../stores/player.js';
import { useSession } from '../composables/useSession.js';
import CoverArt from '../components/CoverArt.vue';
import SongCard from '../components/SongCard.vue';

interface ArtistDetail {
  id: string;
  name: string;
  avatarUrl: string;
  aliases?: string[];
  songCount?: number;
  albumCount?: number;
  platform: string;
  description?: string;
}

interface Album {
  id: string;
  name: string;
  artist: string;
  coverUrl: string;
  songCount?: number;
  platform: string;
}

/** Hot songs shown before the "显示全部" expander (the API returns up to 50). */
const HOT_SONG_PREVIEW = 10;

const store = usePlayerStore();
const route = useRoute();
const { can, guestCan } = useSession();

// Same permission as "play all" on a playlist: members need player.control,
// guests need the playCollection flag.
const canPlayAll = computed(() => can('player.control') || guestCan('playCollection'));
const canShuffle = computed(() =>
  canPlayAll.value && (can('player.control') || guestCan('playMode')),
);

const artist = ref<ArtistDetail | null>(null);
const hotSongs = ref<Song[]>([]);
const albums = ref<Album[]>([]);
const loading = ref(true);
const expanded = ref(false);
let artistRequest = 0;

const platform = computed(() => (route.query.platform as string) || 'netease');
const platformLabel = computed(() => (platform.value === 'qq' ? 'QQ 音乐' : '网易云音乐'));

const visibleCount = computed(() =>
  expanded.value ? hotSongs.value.length : Math.min(HOT_SONG_PREVIEW, hotSongs.value.length),
);
const visibleSongs = computed(() => hotSongs.value.slice(0, visibleCount.value));

function artistId(): string {
  return route.params.id as string;
}

async function playAll() {
  // The server queues the singer's whole catalogue, not just the hot 50.
  await store.playArtist(artistId(), platform.value);
}

async function shuffleAll() {
  if (!canShuffle.value) return;
  // Shuffle reuses the queue's own random mode (the same switch the player
  // toolbar exposes), so the play button and the mode badge stay consistent.
  try {
    await store.setMode('random');
    await store.playArtist(artistId(), platform.value);
  } catch (err: any) {
    store.notify(err?.response?.status === 403 ? '没有权限切换随机播放' : '切换随机播放失败', 'error');
  }
}

async function loadArtist() {
  const request = ++artistRequest;
  loading.value = true;
  // Reset every per-artist piece: RouterView reuses this component when only the
  // route params change, so artist → artist navigation must not show stale rows.
  artist.value = null;
  hotSongs.value = [];
  albums.value = [];
  expanded.value = false;
  try {
    const res = await axios.get(`/api/music/artist/${artistId()}`, {
      params: { platform: platform.value, botId: store.activeBotId ?? undefined },
    });
    if (request !== artistRequest) return;
    artist.value = res.data?.artist ?? null;
    hotSongs.value = res.data?.songs ?? [];
    albums.value = res.data?.albums ?? [];
  } catch {
    if (request !== artistRequest) return;
    artist.value = null;
  } finally {
    if (request === artistRequest) loading.value = false;
  }
}

onMounted(loadArtist);
watch(() => `${route.params.id}|${route.query.platform ?? ''}|${store.activeBotId ?? ''}`, loadArtist);
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

.artist-hero {
  display: flex;
  align-items: center;
  gap: 32px;
  margin-bottom: 36px;
}

.artist-portrait-wrap {
  flex-shrink: 0;
}

.artist-portrait {
  width: 180px;
  height: 180px;
  border-radius: 50%;
  object-fit: cover;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}

.artist-portrait-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 72px;
  color: var(--text-secondary);
  background: var(--bg-card);
}

.artist-meta {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
}

.artist-platform {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-primary);
  margin-bottom: 6px;
}

.artist-title {
  font-size: 32px;
  font-weight: 800;
  margin-bottom: 6px;
}

.artist-aliases {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.artist-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 12px;
}

.artist-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 16px;
  max-width: 640px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.artist-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.play-all-btn,
.shuffle-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 24px;
  border-radius: var(--radius-lg);
  font-size: 14px;
  font-weight: 600;
  transition: transform var(--transition-fast), background var(--transition-fast);

  &:disabled {
    opacity: 0.5;
    cursor: default;
    transform: none;
  }
}

.play-all-btn {
  background: var(--color-primary);
  color: white;
  &:not(:disabled):hover { transform: scale(1.04); }
  &:not(:disabled):active { transform: scale(0.96); }
}

.shuffle-btn {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  &:not(:disabled):hover {
    color: var(--color-primary);
    border-color: var(--color-primary);
    background: var(--color-primary-8);
  }
}

.artist-section {
  margin-bottom: 32px;
}

.section-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 14px;
}

.song-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.more-btn {
  margin-top: 10px;
  padding: 8px 18px;
  font-size: 13px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  transition: color var(--transition-fast), border-color var(--transition-fast);

  &:hover {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }
}

.album-row {
  display: flex;
  gap: 18px;
  overflow-x: auto;
  padding-bottom: 8px;
}

.album-card {
  flex: 0 0 auto;
  width: 150px;
}

.album-name {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 600;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.album-sub {
  font-size: 12px;
  color: var(--text-tertiary);
}

.loading {
  text-align: center;
  padding: 60px;
  color: var(--text-secondary);
}

@media (max-width: 640px) {
  .artist-hero {
    flex-direction: column;
    align-items: flex-start;
    gap: 18px;
  }

  .artist-portrait {
    width: 128px;
    height: 128px;
  }

  .artist-title {
    font-size: 24px;
  }
}
</style>
