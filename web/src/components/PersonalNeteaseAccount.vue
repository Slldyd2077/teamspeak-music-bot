<template>
  <!-- The signed-in user's own NetEase account, used for THEIR 私人FM instead
       of the bot's shared login (#164). -->
  <div class="account-card">
    <div class="account-header">
      <Icon icon="mdi:radio" class="account-icon" />
      <div class="account-info">
        <div class="account-name">我的网易云账号（私人FM）</div>
        <div class="account-status" :class="{ logged: status.loggedIn }">
          <template v-if="status.loggedIn">已绑定: {{ status.nickname }}</template>
          <template v-else-if="status.linked">已绑定，但登录已失效，请重新扫码</template>
          <template v-else>未绑定 — 私人FM使用机器人的共享账号</template>
        </div>
      </div>
    </div>

    <p class="hint">
      绑定后，你在网页端开启的网易云私人FM会按你自己的口味推荐；其他人不受影响。
      仅保存在服务器上，不会显示给任何人。
    </p>

    <div class="login-methods">
      <button class="login-btn" :disabled="qr.loading" @click="startQrLogin">
        <Icon icon="mdi:qrcode" />
        {{ status.linked ? '重新扫码绑定' : '扫码绑定' }}
      </button>
      <button v-if="status.linked" class="login-btn" @click="unlink">
        <Icon icon="mdi:link-off" />
        解除绑定
      </button>
    </div>

    <div v-if="qr.loading" class="qr-loading">
      <Icon icon="mdi:loading" class="spin" />
      生成二维码中...
    </div>
    <div v-else-if="qr.dataUrl" class="qr-wrap">
      <img :src="qr.dataUrl" class="qr-image" alt="QR Code" />
      <div class="qr-status" :class="qr.status">
        <template v-if="qr.status === 'waiting'">
          <Icon icon="mdi:cellphone" /> 请使用网易云音乐APP扫码
        </template>
        <template v-else-if="qr.status === 'scanned'">
          <Icon icon="mdi:check" /> 已扫码，请在手机上确认
        </template>
        <template v-else-if="qr.status === 'confirmed'">
          <Icon icon="mdi:check-circle" /> 绑定成功!
        </template>
        <template v-else-if="qr.status === 'expired'">
          <Icon icon="mdi:refresh" /> 二维码已过期
          <button class="btn-link" @click="startQrLogin">重新生成</button>
        </template>
      </div>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import QRCode from 'qrcode';

const BASE = '/api/me/music/netease';

const status = reactive({ linked: false, loggedIn: false, nickname: '' });
const qr = reactive({
  loading: false,
  dataUrl: '',
  key: '',
  status: 'waiting' as 'waiting' | 'scanned' | 'confirmed' | 'expired',
});
const error = ref('');
let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshStatus() {
  try {
    const res = await axios.get(`${BASE}/status`);
    status.linked = Boolean(res.data?.linked);
    status.loggedIn = Boolean(res.data?.loggedIn);
    status.nickname = res.data?.nickname ?? '';
  } catch {
    // Leave the last known state
  }
}

async function startQrLogin() {
  stopPolling();
  error.value = '';
  qr.loading = true;
  qr.dataUrl = '';
  qr.status = 'waiting';
  try {
    const res = await axios.post(`${BASE}/qrcode`);
    const { qrUrl, qrImg, key } = res.data;
    qr.key = key;
    // Dark-on-light only: many in-app scanners can't read an inverted code.
    qr.dataUrl = qrImg || (await QRCode.toDataURL(qrUrl, {
      width: 200,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    }));
    pollTimer = setInterval(pollQrStatus, 2000);
  } catch (err: any) {
    error.value = err?.response?.data?.error ?? '二维码生成失败';
  } finally {
    qr.loading = false;
  }
}

async function pollQrStatus() {
  if (!qr.key) return;
  try {
    const res = await axios.get(`${BASE}/qrcode/status`, { params: { key: qr.key } });
    qr.status = res.data.status;
    if (qr.status === 'confirmed') {
      stopPolling();
      await refreshStatus();
    } else if (qr.status === 'expired') {
      stopPolling();
    }
  } catch {
    // Ignore poll errors
  }
}

async function unlink() {
  error.value = '';
  try {
    await axios.delete(BASE);
    stopPolling();
    qr.dataUrl = '';
    await refreshStatus();
  } catch (err: any) {
    error.value = err?.response?.data?.error ?? '解除绑定失败';
  }
}

onMounted(refreshStatus);
onUnmounted(stopPolling);
</script>

<style lang="scss" scoped>
.account-card {
  margin-top: 16px;
  padding: 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
}

.account-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.account-icon {
  font-size: 28px;
  color: var(--color-primary);
}

.account-name {
  font-weight: 600;
}

.account-status {
  font-size: 12px;
  color: var(--text-tertiary);
  &.logged { color: var(--color-online); }
}

.hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin: 0 0 12px;
  line-height: 1.5;
}

.login-methods {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.login-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  color: inherit;
  cursor: pointer;
  transition: all var(--transition-fast);
  &:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
  &:disabled { opacity: 0.6; cursor: default; }
}

.qr-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
}

.qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.qr-image {
  width: 200px;
  height: 200px;
  border-radius: var(--radius-md);
  border: 2px solid var(--border-color);
}

.qr-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  &.confirmed { color: var(--color-online); }
}

.btn-link {
  background: none;
  border: none;
  color: var(--color-primary);
  cursor: pointer;
  padding: 0;
}

.error {
  margin-top: 8px;
  font-size: 12px;
  color: #e26a6a;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
