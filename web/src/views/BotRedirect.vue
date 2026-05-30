<template>
  <div class="redirect-page">
    <span v-if="notFound">机器人不存在或未加载</span>
    <span v-else>正在跳转...</span>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePlayerStore } from '../stores/player.js';

const route = useRoute();
const router = useRouter();
const store = usePlayerStore();
const notFound = ref(false);

onMounted(async () => {
  const botId = route.params.id as string;
  if (!store.bots.length) {
    await store.fetchBots();
  }
  const bot = store.bots.find((b) => b.id === botId);
  if (bot) {
    store.setScope(botId);
    router.replace({ path: '/', query: { bot: botId } });
  } else {
    notFound.value = true;
  }
});
</script>

<style scoped>
.redirect-page {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 60vh;
  font-size: 16px;
  color: var(--text-secondary);
}
</style>
