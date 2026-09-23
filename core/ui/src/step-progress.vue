// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import type { StepSegment } from './step-progress-types'
/**
 * 公共基元：N 步进度条（装配九步等）：每段 done 填满 / running 脉动 / failed 红。
 * 段状态由调用方从活动数据推断（基元只渲染——数据不因渲染方式漂移）。
 * 动效：填充过渡 + running 脉动全走令牌；reduced-motion 降级（CSS）。
 */
defineProps<{
  segments: StepSegment[]
  ariaLabel?: string
}>()
</script>

<template>
  <div class="u-step-progress" :aria-label="ariaLabel ?? '进度'">
    <div
      v-for="seg in segments"
      :key="seg.n"
      class="u-seg"
      :class="seg.state"
      :data-seg="seg.n"
    >
      <span class="u-seg-fill" aria-hidden="true"></span>
      <span class="u-seg-label">{{ seg.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.u-step-progress {
  display: flex;
  gap: var(--unself-space-1);
  margin: var(--unself-space-3) 0;
  flex-wrap: wrap;
}
.u-seg {
  flex: 1 1 30%;
  min-width: 96px;
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-sm);
  overflow: hidden;
  background: var(--unself-color-bg);
  position: relative;
  height: var(--unself-space-6);
}
.u-seg-fill {
  position: absolute;
  inset: 0;
  width: 0%;
  background: var(--unself-color-primary);
  transition: width var(--unself-duration-normal) var(--unself-ease-out);
}
.u-seg.running .u-seg-fill {
  width: 35%;
  animation: u-seg-pulse var(--unself-duration-slow) var(--unself-ease-out) infinite alternate;
}
.u-seg.done .u-seg-fill {
  width: 100%;
}
.u-seg.failed .u-seg-fill {
  width: 100%;
  background: var(--unself-color-danger);
}
@keyframes u-seg-pulse {
  from {
    opacity: 0.5;
  }
  to {
    opacity: 1;
  }
}
.u-seg-label {
  position: relative;
  z-index: 1;
  font-size: var(--unself-font-size-xs);
  line-height: var(--unself-space-6);
  padding-left: var(--unself-space-2);
  color: var(--unself-color-text-secondary);
}
.u-seg.done .u-seg-label,
.u-seg.failed .u-seg-label {
  color: var(--unself-color-surface);
}
@media (prefers-reduced-motion: reduce) {
  .u-seg.running .u-seg-fill {
    animation: none;
  }
  .u-seg-fill {
    transition: none;
  }
}
</style>
