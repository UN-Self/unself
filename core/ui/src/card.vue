<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 卡片基元：白底 + 弱阴影 + 圆角容器。
 */
export interface CardProps {
  /** 内边距尺寸（默认 md）。 */
  padding?: 'none' | 'sm' | 'md' | 'lg'
}

withDefaults(defineProps<CardProps>(), { padding: 'md' })
</script>

<template>
  <div class="u-card" :class="`u-card-${padding}`">
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
</style>
