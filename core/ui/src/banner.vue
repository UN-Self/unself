// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
/**
 * 公共基元：信息横幅（提示/警告条）：warning 默认（warning 描边 + surface 底）。
 * 动效：入场 lift+fade 走 v-motion（令牌驱动）；reduced-motion / jsdom 降级。
 */
import { onMounted, ref } from 'vue'
import { TriangleAlert } from 'lucide-vue-next'
import { useMotion } from '@vueuse/motion'
import { liftFadeVariants, motionAvailable } from './motion'

withDefaults(defineProps<{ tone?: 'warning' | 'info' }>(), { tone: 'warning' })

const root = ref<HTMLElement | null>(null)
onMounted(() => {
  if (root.value && motionAvailable()) useMotion(root, liftFadeVariants())
})
</script>

<template>
  <p ref="root" class="u-banner" :class="`u-banner-${tone}`" role="note">
    <TriangleAlert v-if="tone === 'warning'" :size="14" aria-hidden="true" />
    <slot />
  </p>
</template>

<style scoped>
.u-banner {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  border: 1px solid var(--unself-color-warning);
  border-radius: var(--unself-radius-md);
  padding: var(--unself-space-2) var(--unself-space-3);
  background: var(--unself-color-surface);
  margin-bottom: var(--unself-space-3);
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text);
}
.u-banner-info {
  border-color: var(--unself-color-info);
}
</style>
