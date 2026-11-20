<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { ConflictChoice } from '../lib/docs-editor-state'
import { plainSummary } from '../lib/docs-markdown'
import type { Doc } from '../lib/docs-types'

/**
 * 409 冲突对话框：三选一，且「载入服务端」要二次确认。
 * 理由：覆盖和取消都能挽回（草稿还在），载入服务端会**当场丢掉用户刚写的东西**，
 * 必须多一步，避免手滑。
 */
const props = defineProps<{
  open: boolean
  current: Doc | null
  localChars: number
  charDelta: number
  titleChanged: boolean
}>()

const emit = defineEmits<{ choose: [choice: ConflictChoice] }>()

const confirmingReload = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) confirmingReload.value = false
  },
)

const serverSummary = computed(() => (props.current === null ? '' : plainSummary(props.current.content, 60)))

const serverTime = computed(() => {
  if (props.current === null) return ''
  const time = new Date(props.current.updatedAt)
  return Number.isNaN(time.getTime()) ? props.current.updatedAt : time.toLocaleString('zh-CN', { hour12: false })
})

const deltaText = computed(() => {
  if (props.charDelta === 0) return '字数与本地一致'
  return props.charDelta > 0 ? `比本地多 ${props.charDelta} 字` : `比本地少 ${-props.charDelta} 字`
})

function choose(choice: ConflictChoice): void {
  if (choice === 'reload' && !confirmingReload.value) {
    confirmingReload.value = true
    return
  }
  emit('choose', choice)
}
</script>

<template>
  <div v-if="open" class="scrim" data-test="conflict-dialog">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-title"
      tabindex="-1"
      @keydown.esc.stop.prevent="emit('choose', 'cancel')"
    >
      <h2 id="conflict-title">这份文档已被他人保存</h2>
      <p class="lead">
        你手上的版本是旧的。下面三选一，先看清楚再点——「载入服务端」会丢掉你本地刚写的内容。
      </p>

      <dl class="compare">
        <div>
          <dt>服务端</dt>
          <dd>v{{ current?.version ?? '?' }} · {{ serverTime }}</dd>
        </div>
        <div>
          <dt>本地草稿</dt>
          <dd>{{ localChars }} 字 · {{ deltaText }}{{ titleChanged ? ' · 标题有改动' : '' }}</dd>
        </div>
      </dl>

      <blockquote v-if="serverSummary" class="peek">
        {{ serverSummary }}
      </blockquote>

      <div class="actions">
        <button type="button" class="primary" data-test="conflict-overwrite" @click="choose('overwrite')">
          用我的版本覆盖
        </button>
        <button
          type="button"
          class="danger"
          data-test="conflict-reload"
          @click="choose('reload')"
        >
          {{ confirmingReload ? '确认丢弃我的改动？' : '载入服务端版本' }}
        </button>
        <button type="button" class="ghost" data-test="conflict-cancel" @click="choose('cancel')">
          取消，先留着我的
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: var(--unself-color-scrim);
  display: grid;
  place-items: center;
  padding: var(--unself-space-4);
  z-index: 20;
}

.dialog {
  width: min(30rem, 100%);
  background: var(--unself-color-surface);
  border-radius: var(--unself-radius-lg);
  box-shadow: var(--unself-shadow-pop);
  padding: var(--unself-space-6);
  color: var(--unself-color-text);
}
.dialog:focus-visible {
  outline: none;
}

h2 {
  margin: 0 0 var(--unself-space-2);
  font-size: var(--unself-font-size-lg);
}

.lead {
  margin: 0 0 var(--unself-space-4);
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
  line-height: 1.6;
}

.compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--unself-space-2);
  margin: 0 0 var(--unself-space-4);
  font-size: var(--unself-font-size-sm);
}
.compare div {
  background: var(--unself-color-bg);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  padding: var(--unself-space-2) var(--unself-space-3);
}
.compare dt {
  color: var(--unself-color-text-tertiary);
  font-size: var(--unself-font-size-xs);
  margin-bottom: 2px;
}
.compare dd {
  margin: 0;
}

.peek {
  margin: 0 0 var(--unself-space-4);
  padding: var(--unself-space-2) var(--unself-space-3);
  border-left: 3px solid var(--unself-color-border);
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-sm);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--unself-space-2);
  justify-content: flex-end;
}

button {
  font: inherit;
  cursor: pointer;
  border-radius: var(--unself-radius-md);
  padding: var(--unself-space-2) var(--unself-space-3);
  border: 1px solid transparent;
  transition: background var(--unself-duration-fast) var(--unself-ease-out);
}
button:focus-visible {
  outline: none;
  box-shadow: var(--unself-focus-ring);
}

.primary {
  background: var(--unself-color-primary);
  border-color: var(--unself-color-primary);
  color: var(--unself-color-surface);
}
.primary:hover {
  background: var(--unself-color-primary-hover);
}

.danger {
  background: var(--unself-color-danger-soft);
  border-color: var(--unself-color-danger);
  color: var(--unself-color-danger);
}

.ghost {
  background: transparent;
  border-color: var(--unself-color-border);
  color: var(--unself-color-text-secondary);
}
.ghost:hover {
  background: var(--unself-color-surface-hover);
}
</style>
