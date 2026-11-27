<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 公共基元：信息横幅。warning 默认（warning 描边 + surface 底）；info 只换描边；
 * danger = danger-soft 底 + danger 描边，语义是「操作失败、必须回应」，因此默认 role="alert"
 * （其余 tone 是 role="note" 的通报）；调用方可用 role prop 显式覆盖播报级别。
 * 动效：入场 lift+fade 走 v-motion（令牌驱动）；reduced-motion / jsdom 降级。
 */
import { onMounted, ref } from 'vue'
import { CircleAlert, TriangleAlert } from 'lucide-vue-next'
import { liftFadeVariants, motionAvailable } from './motion'

withDefaults(
  defineProps<{ tone?: 'warning' | 'info' | 'danger'; role?: 'note' | 'alert' | 'status' }>(),
  { tone: 'warning', role: undefined },
)

const root = ref<HTMLElement | null>(null)
onMounted(async () => {
  // 动效引擎按需加载：横幅多半不出现（只有告警/错误才挂载），静态 import 会把
  // @vueuse/motion + popmotion 整包塞进所有消费方的首屏。
  if (root.value === null || !motionAvailable()) return
  const { useMotion } = await import('@vueuse/motion')
  useMotion(root.value, liftFadeVariants())
})
</script>

<template>
  <p ref="root" class="u-banner" :class="`u-banner-${tone}`" :role="role ?? (tone === 'danger' ? 'alert' : 'note')">
    <TriangleAlert v-if="tone === 'warning'" :size="14" aria-hidden="true" />
    <CircleAlert v-else-if="tone === 'danger'" :size="14" aria-hidden="true" />
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
/* danger：错误横幅（操作失败、必须回应的提示）——danger-soft 底，role 切 alert。 */
.u-banner-danger {
  border-color: var(--unself-color-danger);
  background: var(--unself-color-danger-soft);
}
</style>
