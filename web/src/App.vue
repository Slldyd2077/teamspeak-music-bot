<template>
  <div class="app" :data-theme="theme">
    <Navbar />
    <main class="main-content">
      <RouterView />
    </main>
    <Player />
    <Toast />

    <!-- Mobile mini player -->
    <div v-if="currentSong" class="m-player" @click="router.push('/lyrics')">
      <div class="m-player-progress">
        <div class="m-player-progress-fill" :style="{ width: mobileProgressPct + '%' }" />
      </div>
      <CoverArt :url="currentSong.coverUrl" :size="40" :radius="8" />
      <div class="m-player-info">
        <div class="m-player-name">{{ currentSong.name }}</div>
        <div class="m-player-artist">{{ currentSong.artist }}</div>
      </div>
      <button class="m-player-btn" @click.stop="playerStore.isPlaying ? playerStore.pause() : playerStore.resume()">
        <Icon :icon="playerStore.isPlaying ? 'mdi:pause' : 'mdi:play'" />
      </button>
      <button class="m-player-btn" @click.stop="playerStore.next()">
        <Icon icon="mdi:skip-next" />
      </button>
    </div>

    <!-- Mobile bottom tab bar -->
    <nav class="m-tabbar">
      <RouterLink to="/" class="m-tab" :class="{ active: route.path === '/' }">
        <Icon icon="mdi:home" class="tab-icon" />
        <span class="tab-label">发现</span>
      </RouterLink>
      <RouterLink to="/search" class="m-tab" :class="{ active: route.path === '/search' }">
        <Icon icon="mdi:magnify" class="tab-icon" />
        <span class="tab-label">搜索</span>
      </RouterLink>
      <RouterLink to="/library" class="m-tab" :class="{ active: route.path === '/library' }">
        <Icon icon="mdi:music-box-multiple" class="tab-icon" />
        <span class="tab-label">音乐库</span>
      </RouterLink>
      <RouterLink to="/settings" class="m-tab" :class="{ active: route.path.startsWith('/settings') }">
        <Icon icon="mdi:cog" class="tab-icon" />
        <span class="tab-label">设置</span>
      </RouterLink>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { usePlayerStore } from './stores/player.js';
import { useWebSocket } from './composables/useWebSocket.js';
import Navbar from './components/Navbar.vue';
import Player from './components/Player.vue';
import CoverArt from './components/CoverArt.vue';
import Toast from './components/Toast.vue';

const playerStore = usePlayerStore();
const theme = computed(() => playerStore.theme);
const route = useRoute();
const router = useRouter();
const { connect } = useWebSocket();
const currentSong = computed(() => playerStore.currentSong);

const mobileProgressPct = ref(0);
let syncTimer: ReturnType<typeof setInterval> | null = null;
let mobileRaf: number | null = null;

function updateMobileProgress() {
  const duration = currentSong.value?.duration ?? 0;
  mobileProgressPct.value = duration > 0
    ? Math.min((playerStore.elapsed / duration) * 100, 100)
    : 0;
  mobileRaf = requestAnimationFrame(updateMobileProgress);
}

onMounted(() => {
  playerStore.loadTheme();
  connect();
  playerStore.fetchBots();
  syncTimer = setInterval(() => playerStore.syncElapsed(), 3000);
  mobileRaf = requestAnimationFrame(updateMobileProgress);
});

onUnmounted(() => {
  if (syncTimer) clearInterval(syncTimer);
  if (mobileRaf !== null) cancelAnimationFrame(mobileRaf);
});
</script>

<style lang="scss">
.app {
  min-height: 100vh;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.main-content {
  padding: 80px 10vw 80px;

  @media (max-width: 1336px) {
    padding: 80px 5vw 80px;
  }

  @media (max-width: 768px) {
    padding: 72px 16px 200px;
  }
}

// Mobile mini player
.m-player {
  position: fixed;
  left: 8px;
  right: 8px;
  bottom: 68px;
  height: 58px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  z-index: 95;
  cursor: pointer;

  @media (min-width: 769px) {
    display: none;
  }
}

.m-player-progress {
  position: absolute;
  top: 0;
  left: 10px;
  right: 10px;
  height: 2px;
}

.m-player-progress-fill {
  height: 2px;
  background: var(--color-primary);
  border-radius: 1px;
}

.m-player-info {
  flex: 1;
  min-width: 0;
}

.m-player-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.m-player-artist {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.m-player-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  opacity: 0.85;
  flex-shrink: 0;
}

// Mobile bottom tab bar
.m-tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding-bottom: env(safe-area-inset-bottom, 0);
  background: var(--bg-navbar);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border-top: 1px solid var(--border-color);
  z-index: 100;

  @media (min-width: 769px) {
    display: none;
  }
}

.m-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 14px;
  color: var(--text-tertiary);
  text-decoration: none;
  font-family: inherit;

  &.active {
    color: var(--color-primary);
  }

  .tab-icon {
    font-size: 22px;
  }

  .tab-label {
    font-size: 10px;
    font-weight: 500;
  }
}
</style>
