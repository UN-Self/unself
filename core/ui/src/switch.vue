<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 开关基元：v-model 布尔开关（role="switch"）。
 * 几何与动效照抄 shadcn-vue Switch（track 36×20、thumb 16×16、
 * checked 位移 16px、track border 2px transparent）；颜色/阴影/焦点环/
 * 时长缓动全走 tokens（§6.5 查找序：beUI 无 Vue 等价 → shadcn-vue 参数）。
 * 键盘可达：原生 button 语义之外显式处理 Space/Enter 并 preventDefault——
 * 防止真实浏览器 keyup 派生的原生 click 造成二次切换，jsdom 与真实浏览器
 * 都保证恰好切换一次。
 */
export interface SwitchProps {
  modelValue: boolean
  disabled?: boolean
}

const props = withDefaults(defineProps<SwitchProps>(), {
  disabled: false,
})

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

function toggle() {
  if (!props.disabled) emit('update:modelValue', !props.modelValue)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault()
    toggle()
  }
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-disabled="disabled || undefined"
    :disabled="disabled"
    class="u-switch"
    :class="modelValue ? 'u-switch-on' : 'u-switch-off'"
    @click="toggle"
    @keydown="onKeydown"
  >
    <span class="u-switch-thumb" aria-hidden="true" />
  </button>
</template>

<style scoped>
.u-switch {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  width: 36px;
  height: 20px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: var(--unself-radius-full);
  background: var(--unself-color-border);
  cursor: pointer;
  transition: background-color var(--unself-duration-fast) var(--unself-ease-out);
}
.u-switch:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}
.u-switch:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.u-switch-off {
  background: var(--unself-color-border);
}
.u-switch-on {
  background: var(--unself-color-primary);
}

.u-switch-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: var(--unself-radius-full);
  background: var(--unself-color-bg);
  box-shadow: var(--unself-shadow-card);
  transform: translateX(0);
  transition: transform var(--unself-duration-fast) var(--unself-ease-out);
}
.u-switch-on .u-switch-thumb {
  transform: translateX(16px);
}
</style>
