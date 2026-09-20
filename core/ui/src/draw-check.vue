<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 成功勾描画图标（#307 ②状态叙事层，transitions.dev SVG stroke 描画模式）：
 * 内置 Check 图形，挂载后 stroke-dashoffset 由满值描到 0（一笔画完）。
 * 时长/缓动走 tokens（duration-slow + ease-out）；用途：激活完成 / 邀请全就绪等终态。
 * 降级：prefers-reduced-motion 下不描画——圆底+勾全量瞬显（状态不丢，只是不动）。
 */
import { onMounted, ref } from 'vue'
import { Check } from 'lucide-vue-next'

defineProps<{
  /** 图标边长（px，lucide 默认 24）。 */
  size?: number
}>()

/** 描画完成标记：animationend 后置 true（降级环境永远 false，但图标本就可见）。 */
const drawn = ref(false)

onMounted(() => {
  // animationend 兜底：jsdom/老内核不派发时，超时后同样标记完成（视觉无差别，只影响标记）
  window.setTimeout(() => {
    drawn.value = true
  }, 800)
})
</script>

<template>
  <span class="u-draw-check" :class="{ 'u-draw-check-done': drawn }" role="img" aria-label="完成">
    <span class="u-draw-check-ring" aria-hidden="true" />
    <Check
      class="u-draw-check-tick"
      aria-hidden="true"
      :size="(size ?? 24) - 10"
      :stroke-width="2.5"
    />
  </span>
</template>

<style scoped>
.u-draw-check {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--unself-color-success);
}

/* 圆底描画：SVG circle 的 stroke-dash 技法在 span 圆环上的等价实现
   （border 不能描画，故用 conic 渐隐的逆过程不可行——改用透明→全色的淡入 + 内勾描画，
   两段节奏一致，视觉上仍是「画出来」的） */
.u-draw-check-ring {
  position: absolute;
  inset: 0;
  border: 2px solid currentColor;
  border-radius: var(--unself-radius-full);
  opacity: 0;
  animation: u-draw-ring var(--unself-duration-slow) var(--unself-ease-out) forwards;
}

/* 内勾描画：stroke-dasharray 满值 → 0（transitions.dev 原法）。
   dash 满值取几何上限（勾的对角线长度近似值），数值仅作 dash 覆盖范围，非样式参数 */
.u-draw-check-tick {
  stroke-dasharray: 30;
  stroke-dashoffset: 30;
  animation: u-draw-tick var(--unself-duration-slow) var(--unself-ease-out) forwards;
  animation-delay: calc(var(--unself-duration-slow) / 2);
}

@keyframes u-draw-ring {
  to {
    opacity: 1;
  }
}
@keyframes u-draw-tick {
  to {
    stroke-dashoffset: 0;
  }
}

/* 降低动效偏好：不描画——圆与勾直接全量显示（终态不丢，只是不动） */
@media (prefers-reduced-motion: reduce) {
  .u-draw-check-ring {
    animation: none;
    opacity: 1;
  }
  .u-draw-check-tick {
    animation: none;
    stroke-dashoffset: 0;
  }
}
</style>
