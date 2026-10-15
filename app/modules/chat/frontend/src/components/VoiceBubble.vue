// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { AudioLines, Pause, Play } from 'lucide-vue-next'

import { formatVoiceDuration } from '../lib/waveform'
import type { Attachment } from '../lib/types'

/**
 * 语音气泡（#218；#339④ 一点即播）：kind=voice/audio 附件 → 波形 + 时长 + 播放/暂停。
 * 波形条高度出附件 waveform 采样（0-100），无采样时退化为等高占位条；
 * 播放态由 <audio> 事件驱动（父级换源后自动停摆），组件零计时器。
 *
 * #339④：点击气泡 = 打开播放器并立即播放（不再有「展开→再点播放」两步）；
 * 再点 = 暂停/继续（播放器常驻不收起）；播放态图标随动（AudioLines/Play/Pause）。
 */
export interface VoiceBubbleProps {
  attachment: Attachment
}

const props = defineProps<VoiceBubbleProps>()
const emit = defineEmits<{
  /** 打开播放器（是否当前语音源）；不再收起，仅首次打开时发。保留事件面供父层扩展互斥。 */
  toggle: [open: boolean]
  error: []
}>()

const open = ref(false)
const playing = ref(false)
const audioEl = ref<HTMLAudioElement | null>(null)

/** 有真实波形 → 渲染采样条；否则退化为等高条（高度 40%）。 */
const bars = computed(() => {
  if (props.attachment.waveform?.length) return props.attachment.waveform
  return null
})
const fallbackLevels = [40, 55, 35, 60, 45, 50, 38, 58, 42, 52] as const

const durationLabel = computed(() => formatVoiceDuration(props.attachment.durationMs ?? 0))

async function onToggle(): Promise<void> {
  if (!open.value) {
    open.value = true
    emit('toggle', true)
    // 一点即播：audio 挂载后立即起播；jsdom 无媒体引擎，play() 缺失/被拒时静默（测试断言 DOM 面不断言出声）
    await nextTick()
    void audioEl.value?.play().catch(() => {})
    return
  }
  // 已打开：暂停/继续切换（播放器常驻，不收起）
  const el = audioEl.value
  if (!el) return
  if (el.paused) void el.play().catch(() => {})
  else el.pause()
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
    <button
      type="button"
      class="voice-toggle"
      :aria-expanded="open"
      :aria-label="open ? (playing ? '暂停语音' : '继续播放语音') : '播放语音'"
      @click="onToggle"
    >
      <Pause v-if="open && playing" :size="14" aria-hidden="true" />
      <Play v-else-if="open" :size="14" aria-hidden="true" />
      <AudioLines v-else :size="14" aria-hidden="true" />
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

    <!-- #339④：首次点击后常驻挂载（不再收起）；一点即播由 onToggle 驱动 -->
    <audio
      v-if="open"
      ref="audioEl"
      class="voice-audio"
      controls
      preload="none"
      @error="emit('error')"
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
