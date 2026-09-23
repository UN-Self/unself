// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
/**
 * 公共基元：结果卡（装配/激活类操作的收尾卡）：标签 + 链接码 + 动作区。
 * tone=success 正常收尾；tone=warning 部分成功（如失败但入口已注册，可先继续）。
 * 动效：入场 spring 变体走 v-motion（令牌驱动）；reduced-motion / jsdom 降级。
 */
import { computed, onMounted, ref } from 'vue'
import { useMotion } from '@vueuse/motion'
import { liftFadeVariants, motionAvailable } from './motion'

const props = defineProps<{
  /** 卡内标签（如「部署入口已就绪」）。 */
  label: string
  /** 链接码（完整 URL 或深链）。 */
  link: string
  tone?: 'success' | 'warning'
}>()

const tone = computed(() => props.tone ?? 'success')

const root = ref<HTMLElement | null>(null)
onMounted(() => {
  if (root.value && motionAvailable()) useMotion(root, liftFadeVariants())
})
</script>

<template>
  <section ref="root" class="u-result-card" :class="`u-result-${tone}`" aria-label="部署入口">
    <span class="u-result-label">{{ label }}</span>
    <code class="u-result-link" data-test="result-link">{{ link }}</code>
    <div class="u-result-actions">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.u-result-card {
  display: grid;
  gap: var(--unself-space-3);
  max-width: 32rem;
  margin: var(--unself-space-4) auto;
  padding: var(--unself-space-4);
  border: 1px solid var(--unself-color-success);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-primary-soft);
}
.u-result-warning {
  border-color: var(--unself-color-warning);
  background: var(--unself-color-surface);
}
.u-result-label {
  color: var(--unself-color-success);
  font-size: var(--unself-font-size-sm);
  font-weight: 600;
}
.u-result-warning .u-result-label {
  color: var(--unself-color-warning);
}
.u-result-link {
  padding: var(--unself-space-2);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-sm);
  background: var(--unself-color-surface);
  text-align: left;
}
.u-result-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--unself-space-2);
}
</style>
