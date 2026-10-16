<template>
  <div v-if="modal.open" class="edit-modal-overlay" @click.self="store.closeBilibiliPartModal">
    <div class="edit-modal">
      <h3 class="modal-title">选择分P</h3>

      <div class="form-group">
        <label>视频名称</label>
        <div class="video-info-box">
          <CoverArt :url="modal.coverUrl" :size="44" :radius="8" />
          <div class="video-meta">
            <div class="video-title" :title="modal.title">{{ modal.title }}</div>
            <div class="video-hint">共 {{ modal.parts.length }} 个分P · {{ actionHint }}</div>
          </div>
        </div>
      </div>

      <div class="form-group">
        <label>分P列表</label>
        <div class="parts-list">
          <div
            v-for="part in modal.parts"
            :key="part.part"
            class="part-item"
            :class="{ active: selectedPart?.part === part.part }"
            @click="selectedPart = part"
            @dblclick="confirmSelect(part)"
          >
            <span class="part-badge">P{{ part.part }}</span>
            <span class="part-name" :title="part.title">{{ part.title }}</span>
            <span class="part-duration">{{ formatDuration(part.duration) }}</span>
          </div>
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn-secondary" @click="store.closeBilibiliPartModal">取消</button>
        <button
          class="btn-primary"
          :disabled="!selectedPart"
          @click="selectedPart && confirmSelect(selectedPart)"
        >
          {{ confirmBtnText }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { usePlayerStore, type BiliPart } from '../stores/player.js';
import CoverArt from './CoverArt.vue';

const store = usePlayerStore();
const modal = computed(() => store.biliPartModal);

const selectedPart = ref<BiliPart | null>(null);

// 弹窗打开时默认选中第 1 P
watch(
  () => modal.value.open,
  (open) => {
    if (open && modal.value.parts.length > 0) {
      selectedPart.value = modal.value.parts[0];
    } else {
      selectedPart.value = null;
    }
  },
  { immediate: true },
);

const actionHint = computed(() => {
  if (modal.value.action === 'playNext') return '添加到下一首播放';
  if (modal.value.action === 'add') return '添加到播放队列';
  return '立即播放';
});

const confirmBtnText = computed(() => {
  if (modal.value.action === 'playNext') return '下一首播放';
  if (modal.value.action === 'add') return '添加到队列';
  return '播放';
});

function confirmSelect(part: BiliPart) {
  store.selectBilibiliPart(part);
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
</script>

<style lang="scss" scoped>
.edit-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
}

.edit-modal {
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  padding: 28px;
  width: 480px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.modal-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 20px;
  color: var(--text-primary);
}

.form-group {
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  min-height: 0;

  label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 6px;
    opacity: 0.7;
    color: var(--text-primary);
  }
}

.video-info-box {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--hover-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);

  .video-meta {
    flex: 1;
    min-width: 0;
  }

  .video-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 2px;
  }

  .video-hint {
    font-size: 12px;
    color: var(--text-secondary);
  }
}

.parts-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
  padding-right: 4px;

  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--border-color);
    border-radius: var(--radius-sm);
  }
}

.part-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--hover-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);

  &:hover {
    border-color: var(--color-primary);
    background: var(--color-primary-10, rgba(0, 161, 214, 0.08));
  }

  &.active {
    border-color: var(--color-primary);
    background: var(--color-primary-15, rgba(0, 161, 214, 0.15));

    .part-badge {
      background: var(--color-primary);
      color: white;
    }

    .part-name {
      color: var(--color-primary);
      font-weight: 600;
    }
  }

  .part-badge {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: var(--radius-xs);
    background: var(--color-primary-10, rgba(0, 161, 214, 0.1));
    color: var(--color-primary);
    flex-shrink: 0;
    transition: all var(--transition-fast);
  }

  .part-name {
    flex: 1;
    font-size: 13px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .part-duration {
    font-size: 12px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
}

.modal-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 10px;
}

.btn-primary {
  padding: 10px 20px;
  background: var(--color-primary);
  color: white;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  border: none;
  cursor: pointer;
  transition: transform var(--transition-fast);

  &:hover:not(:disabled) {
    transform: scale(1.02);
  }
  &:active:not(:disabled) {
    transform: scale(0.98);
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.btn-secondary {
  padding: 10px 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  border: none;
  cursor: pointer;
  transition: opacity var(--transition-fast);

  &:hover {
    opacity: 0.8;
  }
}
</style>
