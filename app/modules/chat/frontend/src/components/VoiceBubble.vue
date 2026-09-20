// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { computed, ref } from 'vue'
import { AudioLines } from 'lucide-vue-next'

import { formatVoiceDuration } from '../lib/waveform'
import type { Attachment } from '../lib/types'

/**
 * 语音气泡（#218）：kind=voice/audio 附件 → 波形 + 时长 + 播放/暂停。
 * 波形条高度出附件 waveform 采样（0-100），无采样时退化为等高占位条；
 * 播放态由 <audio> 事件驱动（父级换源后自动停摆），组件零计时器。
 */
export interface VoiceBubbleProps {
  attachment: Attachment
}

const props = defineProps<VoiceBubbleProps>()
const emit = defineEmits<{
  /** 打开/收起播放器（是否当前语音源），参数为「是否打开」。 */
  toggle: [open: boolean]
}>()

const open = ref(false)
const playing = ref(false)

/** 有真实波形 → 渲染采样条；否则退化为等高条（高度 40%）。 */
const bars = computed(() => {
  if (props.attachment.waveform?.length) return props.attachment.waveform
  return null
})
const fallbackLevels = [40, 55, 35, 60, 45, 50, 38, 58, 42, 52] as const

const durationLabel = computed(() => formatVoiceDuration(props.attachment.durationMs ?? 0))

function onToggle(): void {
  open.value = !open.value
  if (!open.value) {
    playing.value = false
  }
  emit('toggle', open.value)
}

function onPlay(): void {
  playing.value = true
}
function onPause(): void {
  playing.value = false
}
</script>

<template>
  <div class="voice" data-test="voice-bubble">
    <button type="button" class="voice-toggle" :aria-expanded="open" @click="onToggle">
      <AudioLines :size="14" aria-hidden="true" />
      <span class="voice-wave" aria-hidden="true">
        <template v-if="bars">
          <span
            v-for="(level, i) in bars"
            :key="i"
            class="voice-bar"
            :style="{ height: `${Math.min(100, Math.max(8, level))}%` }"
          />
        </template>
        <template v-else>
          <span
            v-for="(level, i) in fallbackLevels"
            :key="i"
            class="voice-bar"
            :style="{ height: `${level}%` }"
          />
        </template>
      </span>
      <span class="voice-duration">{{ durationLabel }}</span>
    </button>

    <!-- 播放器按需挂载：点击气泡才出 <audio>，避免长列表隐藏音频面 -->
    <audio
      v-if="open"
      class="voice-audio"
      controls
      :src="attachment.url"
      data-test="voice-audio"
      @play="onPlay"
      @pause="onPause"
      @ended="onPause"
    ></audio>
  </div>
</template>

<style scoped>
.voice {
  display: inline-flex;
  flex-direction: column;
  gap: var(--unself-space-1);
  max-width: 100%;
}
.voice-toggle {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  min-height: var(--unself-touch-target);
  padding: var(--unself-space-1) var(--unself-space-2);
  border: none;
  border-radius: var(--unself-radius-md);
  background: transparent;
  cursor: pointer;
  transition: background-color var(--unself-duration-fast) var(--unself-ease-out);
}
.voice-toggle:hover {
  background: var(--unself-color-surface-hover);
}
.voice-toggle:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}
.voice-wave {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: var(--unself-space-6);
}
.voice-bar {
  width: 3px;
  border-radius: var(--unself-radius-full);
  background: currentColor;
  opacity: 0.7;
}
.voice-duration {
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
  font-variant-numeric: tabular-nums;
}
.voice-audio {
  width: 100%;
  max-width: 240px;
  height: var(--unself-touch-target);
}
</style>
