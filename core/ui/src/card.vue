<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 卡片基元：白底 + 弱阴影 + 圆角容器。
 * #307 ①基础反馈层：interactive 卡片（可点击/可进入的卡）悬浮浮起——
 * translateY(-lift-y) + 阴影 card→pop（rareui hover card 语义）。
 * 默认关闭：表单大卡/弹层卡是静态容器，不该动（#307 拍板：保守）。
 */
export interface CardProps {
  /** 内边距尺寸（默认 md）。 */
  padding?: 'none' | 'sm' | 'md' | 'lg'
  /** 可交互卡（悬浮浮起）；默认 false（静态容器不动）。 */
  interactive?: boolean
}

withDefaults(defineProps<CardProps>(), { padding: 'md', interactive: false })
</script>

<template>
  <div class="u-card" :class="[`u-card-${padding}`, { 'u-card-interactive': interactive }]">
    <slot />
  </div>
</template>

<style scoped>
.u-card {
  background: var(--unself-color-bg);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  box-shadow: var(--unself-shadow-card);
}
.u-card-none { padding: 0; }
.u-card-sm { padding: var(--unself-space-3); }
.u-card-md { padding: var(--unself-space-6); }
.u-card-lg { padding: var(--unself-space-8); }

/* #307 ①基础反馈层：可交互卡悬浮浮起（rareui hover card）。
   @media (hover: hover)：触屏无悬浮，粘滞触发反而干扰；hover 媒体特性不可 var()。 */
@media (hover: hover) {
  .u-card-interactive {
    transition:
      transform var(--unself-duration-fast) var(--unself-ease-out),
      box-shadow var(--unself-duration-fast) var(--unself-ease-out);
  }
  .u-card-interactive:hover {
    transform: translateY(calc(-1 * var(--unself-motion-lift-y)));
    box-shadow: var(--unself-shadow-pop);
  }
}
/* 降低动效偏好：浮起位移归零（阴影即时切换，仍给可交互暗示） */
@media (prefers-reduced-motion: reduce) {
  @media (hover: hover) {
    .u-card-interactive:hover {
      transform: none;
    }
  }
}
</style>
