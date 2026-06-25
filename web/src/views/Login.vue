<template>
  <div class="auth-page">
    <form class="auth-card" @submit.prevent="submit">
      <h1>登录 TSMusicBot</h1>
      <label>
        <span>用户名</span>
        <input v-model="username" type="text" autocomplete="username" autofocus required />
      </label>
      <label>
        <span>密码</span>
        <input v-model="password" type="password" autocomplete="current-password" required />
      </label>
      <p v-if="error" class="auth-error">{{ error }}</p>
      <button type="submit" :disabled="loading">{{ loading ? '登录中…' : '登录' }}</button>
    </form>
    <button
      v-if="session.guestAllowed.value"
      type="button"
      class="guest-btn"
      :disabled="loading"
      @click="enterAsGuest"
    >
      以游客身份进入
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSession } from '../composables/useSession.js';

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
const router = useRouter();
const route = useRoute();
const session = useSession();

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await session.login(username.value, password.value);
    const rawNext = typeof route.query.next === 'string' ? route.query.next : '/';
    const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
    router.replace(next);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function enterAsGuest() {
  error.value = '';
  loading.value = true;
  try {
    await session.continueAsGuest();
    const rawNext = typeof route.query.next === 'string' ? route.query.next : '/';
    const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
    router.replace(next);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped lang="scss">
.auth-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
}
.auth-card {
  width: 360px;
  padding: 32px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-shadow: var(--shadow-dropdown);
}
.auth-card h1 { margin: 0 0 8px; font-size: 20px; color: var(--text-primary); }
.auth-card label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.auth-card input {
  height: 36px; padding: 0 10px; border-radius: var(--radius-sm);
  background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-color);
}
.auth-card button {
  height: 38px; border-radius: var(--radius-sm); border: 0;
  background: var(--color-primary); color: #fff; font-weight: 500; cursor: pointer;
}
.auth-card button:disabled { opacity: 0.6; cursor: progress; }
.auth-error { color: #e26a6a; font-size: 13px; margin: 0; }
.guest-btn {
  width: 360px; height: 38px; margin-top: 4px; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-secondary);
  border: 1px solid var(--border-color); cursor: pointer;
}
.guest-btn:hover { color: var(--text-primary); }
.guest-btn:disabled { opacity: 0.6; cursor: progress; }
</style>
