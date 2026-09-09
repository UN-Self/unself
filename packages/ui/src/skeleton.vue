<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 骨架屏基元（#83 收编）：壳内两处手写骨架（引导阶段 / 模块握手）共用同一套
 * 线条 + shimmer 样式；宽度/布局由消费方容器约束，本组件只关心行数与末行缩短。
 */
export interface SkeletonProps {
  /** 线条数（默认 2）。 */
  lines?: number
  /** 最后一行是否缩短为 60% 宽（默认 true）。 */
  shortenLast?: boolean
}

withDefaults(defineProps<SkeletonProps>(), {
  lines: 2,
  shortenLast: true,
})
</script>

<template>
  <div class="u-skeleton" role="status" aria-busy="true">
    <span
      v-for="i in lines"
      :key="i"
      class="u-skeleton-line"
      :class="{ 'u-skeleton-line-short': shortenLast && i === lines }"
      aria-hidden="true"
    />
  </div>
</template>

<style scoped>
.u-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
  width: 100%;
}
.u-skeleton-line {
  display: block;
  height: 14px;
  border-radius: var(--unself-radius-sm);
  background: linear-gradient(
    90deg,
    var(--unself-color-surface) 25%,
    var(--unself-color-surface-hover) 50%,
    var(--unself-color-surface) 75%
  );
  background-size: 200% 100%;
  animation: u-shimmer 1.4s ease infinite;
}
.u-skeleton-line-short {
  width: 60%;
}
@keyframes u-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
</style>
