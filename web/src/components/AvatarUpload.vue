<template>
  <div class="avatar-upload">
    <div class="preview" :class="{ empty: !previewUrl }">
      <img v-if="previewUrl" :src="previewUrl" alt="avatar" />
      <Icon v-else icon="mdi:account-circle-outline" />
    </div>
    <div class="actions">
      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        class="hidden"
        @change="onFile"
      />
      <button type="button" class="btn-sm" @click="fileInput?.click()">
        {{ previewUrl ? '更换' : '上传' }}
      </button>
      <button v-if="previewUrl" type="button" class="btn-sm btn-danger" @click="clear">
        删除
      </button>
    </div>
    <p v-if="error" class="hint error">{{ error }}</p>
    <p v-else class="hint">PNG / JPG / WebP，≤200 KB</p>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { Icon } from '@iconify/vue';

const props = defineProps<{ modelValue: string | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>();

const previewUrl = ref<string | null>(props.modelValue);
const error = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

watch(() => props.modelValue, (v) => { previewUrl.value = v; });

function onFile(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    error.value = '仅支持 PNG / JPG / WebP';
    return;
  }
  if (file.size > 200 * 1024) {
    error.value = `图片 ${(file.size / 1024).toFixed(0)} KB 超过 200 KB 上限`;
    return;
  }
  error.value = null;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result as string;
    previewUrl.value = dataUrl;
    emit('update:modelValue', dataUrl);
  };
  reader.readAsDataURL(file);
}

function clear() {
  previewUrl.value = null;
  emit('update:modelValue', null);
  if (fileInput.value) fileInput.value.value = '';
}
</script>

<style lang="scss" scoped>
.avatar-upload { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }

.preview {
  width: 80px; height: 80px; border-radius: 50%;
  background: var(--bg-card); display: flex; align-items: center; justify-content: center;
  overflow: hidden;

  img { width: 100%; height: 100%; object-fit: cover; }
  &.empty :deep(svg) { font-size: 48px; opacity: 0.4; }
}

.actions { display: flex; gap: 8px; }
.hidden { display: none; }

.btn-sm {
  padding: 6px 14px;
  background: var(--hover-bg);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
  transition: all var(--transition-fast);
  &:hover { background: var(--color-primary); color: white; }
}

.btn-danger {
  &:hover { background: #f44336; color: white; }
}

.hint { font-size: 12px; opacity: 0.6; margin: 0; }
.hint.error { color: #f44336; opacity: 1; }
</style>
