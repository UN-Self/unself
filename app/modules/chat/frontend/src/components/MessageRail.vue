// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDown } from 'lucide-vue-next'
import { UButton } from '@unself/ui'
import type { Message } from '../lib/types'

// 交互参考 beUI MessageScroller / PreviewRail：侧轨刻度 + 悬停预览 + 回到最新。
const props = defineProps<{
  messages: Message[]
  activeId: number | null
  following: boolean
}>()
const emit = defineEmits<{ select: [id: number]; latest: [] }>()

// 长会话按已加载范围均匀取点，保留两端，避免侧轨随历史分页无限增长。
const items = computed(() => {
  const count = Math.min(props.messages.length, 24)
  return Array.from({ length: count }, (_, index) => {
    const message = props.messages[Math.round(index * (props.messages.length - 1) / Math.max(1, count - 1))]!
    return {
      id: message.id,
      sender: message.sender.displayName || message.sender.username,
      preview: message.content.trim().replace(/\s+/g, ' ').slice(0, 80)
        || (message.attachment?.kind === 'voice' ? '[语音]' : message.attachment?.name || '[消息]'),
    }
  })
})
const activeIndex = computed(() => {
  const index = props.messages.findIndex((message) => message.id === props.activeId)
  return Math.round(Math.max(0, index) * (items.value.length - 1) / Math.max(1, props.messages.length - 1))
})
</script>

<template>
  <nav class="message-rail" aria-label="消息导航">
    <div class="rail-ticks">
      <button
        v-for="(item, index) in items"
        :key="item.id"
        type="button"
        class="rail-stop"
        :aria-current="index === activeIndex ? 'location' : undefined"
        :aria-label="`定位消息：${item.sender}，${item.preview}`"
        @click="emit('select', item.id)"
      >
        <span class="rail-tick" aria-hidden="true" />
        <span class="rail-preview" aria-hidden="true"><strong>{{ item.sender }}</strong><span>{{ item.preview }}</span></span>
      </button>
    </div>
    <UButton v-if="!following" class="rail-latest" variant="outline" size="sm" aria-label="回到最新消息" title="回到最新消息" @click="emit('latest')">
      <ArrowDown :size="16" aria-hidden="true" />
    </UButton>
  </nav>
</template>

<style scoped>
.message-rail {
  position: absolute;
  inset-block: var(--unself-space-5);
  inset-inline-end: var(--unself-space-2);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  width: var(--unself-space-8);
  pointer-events: none;
}
.rail-ticks {
  display: flex;
  flex-direction: column;
  max-height: calc(100% - var(--unself-space-8) - var(--unself-space-4));
  width: 100%;
  pointer-events: auto;
}
.rail-stop {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: 0 1 var(--unself-space-5);
  min-height: var(--unself-space-2);
  padding: var(--unself-space-1);
  border: 0;
  background: transparent;
  cursor: pointer;
  touch-action: manipulation;
}
.rail-tick {
  width: var(--unself-space-3);
  height: calc(var(--unself-space-1) / 2);
  flex-shrink: 0;
  background: var(--unself-color-border);
  border-radius: var(--unself-radius-full);
  transition: width var(--unself-duration-fast) var(--unself-ease-out), background var(--unself-duration-fast) var(--unself-ease-out);
}
.rail-stop[aria-current], .rail-stop:hover, .rail-stop:focus-visible { z-index: 1; }
.rail-stop[aria-current] .rail-tick, .rail-stop:hover .rail-tick, .rail-stop:focus-visible .rail-tick {
  width: var(--unself-space-6);
  background: var(--unself-color-primary);
}
.rail-stop:focus-visible { outline: var(--unself-focus-ring); border-radius: var(--unself-radius-sm); }
.rail-preview {
  position: absolute;
  inset-inline-end: calc(100% + var(--unself-space-2));
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
  width: max-content;
  max-width: min(60vw, 18rem);
  padding: var(--unself-space-2) var(--unself-space-3);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  color: var(--unself-color-text-secondary);
  background: var(--unself-color-surface);
  box-shadow: var(--unself-shadow-pop);
  font-size: var(--unself-font-size-xs);
  text-align: start;
  opacity: 0;
  visibility: hidden;
  transform: translateX(var(--unself-space-1));
  pointer-events: none;
  transition: opacity var(--unself-duration-fast) var(--unself-ease-out), transform var(--unself-duration-fast) var(--unself-ease-out);
}
.rail-preview strong { color: var(--unself-color-text); font-weight: 500; }
.rail-preview span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-stop:hover .rail-preview, .rail-stop:focus-visible .rail-preview { visibility: visible; opacity: 1; transform: translateX(0); }
.rail-latest { position: absolute; bottom: 0; padding: var(--unself-space-2); pointer-events: auto; box-shadow: var(--unself-shadow-card); }
@media (prefers-reduced-motion: reduce) {
  .rail-tick, .rail-preview { transition: none; }
}
</style>
