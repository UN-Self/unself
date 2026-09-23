// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import type { StepperStep } from './stepper-types'
/**
 * 公共基元：横向步进器（向导/流程通用）：三态（done 可点回退 / current / future）。
 * 键盘可达：done 项 role=button + tabindex + Enter/Space 触发（目标步由调用方守卫——
 * 只允许已完成步，组件只发事件不做权限判定）。
 * 动效：hover 浮起（lift-y token）；reduced-motion 降级（CSS）。
 */
const props = defineProps<{
  steps: StepperStep[]
  /** 当前步在 steps 中的下标。 */
  current: number
  ariaLabel?: string
}>()

const emit = defineEmits<{ navigate: [id: string] }>()

function onKeydown(event: KeyboardEvent, id: string): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    emit('navigate', id)
  }
}
</script>

<template>
  <ol class="u-stepper" :aria-label="ariaLabel ?? '进度'">
    <li
      v-for="(step, i) in steps"
      :key="step.id"
      class="u-stepper-item"
      :class="i < current ? 'done' : i === current ? 'current' : 'future'"
      :role="i < current ? 'button' : undefined"
      :tabindex="i < current ? 0 : undefined"
      :data-goto="i < current ? step.id : undefined"
      @click="i < current && emit('navigate', step.id)"
      @keydown="i < current && onKeydown($event, step.id)"
    >
      <span class="u-stepper-dot" aria-hidden="true">{{ i < current ? '✓' : i + 1 }}</span>
      <span class="u-stepper-label">{{ step.label }}</span>
    </li>
  </ol>
</template>

<style scoped>
.u-stepper {
  display: flex;
  gap: var(--unself-space-1);
  list-style: none;
  padding: 0;
  margin: 0 0 var(--unself-space-5);
  flex-wrap: wrap;
}
.u-stepper-item {
  display: flex;
  align-items: center;
  gap: var(--unself-space-1);
  padding: var(--unself-space-1) var(--unself-space-2);
  border-radius: var(--unself-radius-full);
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-tertiary);
  background: none;
  border: 0;
  font: inherit;
  transition:
    color var(--unself-duration-fast) var(--unself-ease-out),
    background var(--unself-duration-fast) var(--unself-ease-out),
    transform var(--unself-duration-fast) var(--unself-ease-spring);
}
.u-stepper-item.done {
  color: var(--unself-color-success);
  cursor: pointer;
}
.u-stepper-item.done:hover {
  background: var(--unself-color-surface-hover);
  transform: translateY(calc(-1 * var(--unself-motion-lift-y)));
}
.u-stepper-item.current {
  color: var(--unself-color-primary);
  font-weight: 600;
}
.u-stepper-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--unself-space-5);
  height: var(--unself-space-5);
  border-radius: var(--unself-radius-full);
  border: 1px solid var(--unself-color-border);
  background: var(--unself-color-surface);
  font-size: var(--unself-font-size-xs);
}
.u-stepper-item.done .u-stepper-dot {
  border-color: var(--unself-color-success);
  background: var(--unself-color-success);
  color: var(--unself-color-surface);
}
.u-stepper-item.current .u-stepper-dot {
  border-color: var(--unself-color-primary);
  background: var(--unself-color-primary-soft);
  color: var(--unself-color-primary);
}
@media (prefers-reduced-motion: reduce) {
  .u-stepper-item,
  .u-stepper-item.done:hover {
    transition: none;
    transform: none;
  }
}
</style>
