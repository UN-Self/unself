<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { UChoiceCardGroupProps } from './choice-card-types'
/**
 * 公共基元：单选/多选勾选卡（§6.5 组件查找序① beUI select 家族卡片化形态；
 * shadcn RadioGroup/Checkbox 卡片同构）。视觉=卡片即控件：整卡可点、
 * 选中态 primary 描边+soft 底、左侧自绘勾选指示（checkbox ✓ / radio 圆点）。
 * 键盘可达：原生 input（radio 由浏览器组内方向键；checkbox 空格）承载交互，
 * 自绘指示 aria-hidden；focus-visible 环画在指示上（:focus-visible + 兄弟选择器）。
 * 动效：卡入场走 v-motion（liftFadeVariants，令牌驱动）；指示 pop 走 CSS——
 * transform 全部由契约令牌计算（scale(1/press-scale) 选中回弹、scale(press-scale) 初始、
 * 位移用 lift-y），时长/缓动取 duration-fast + ease-spring；reduced-motion 双路降级
 * （变体 duration 0 + transition none），无任何硬编码动效数值。
 */
import { onMounted, ref } from 'vue'
import { Check } from 'lucide-vue-next'
import { useMotion } from '@vueuse/motion'
import { liftFadeVariants, motionAvailable } from './motion'

/**
 * 卡片元素（入场 lift+fade 变体挂载点）。v-for 中的模板 ref 是**数组**——
 * 单 HTMLElement ref 只会收到最后一卡，其余卡从未获得动效实例。
 */
const cardEls = ref<HTMLElement[]>([])
onMounted(() => {
  // jsdom/无 style 引擎环境跳过（motionAvailable 检测）；真实浏览器全量走 v-motion
  if (!motionAvailable()) return
  for (const el of cardEls.value) {
    if (el) useMotion(el, liftFadeVariants())
  }
})
const props = withDefaults(defineProps<UChoiceCardGroupProps>(), {
  modelValue: null,
  modelValues: () => [],
  name: undefined,
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string | null]
  'update:modelValues': [value: string[]]
}>()

function isSelected(option: { value: string }): boolean {
  return props.mode === 'radio'
    ? props.modelValue === option.value
    : props.modelValues.includes(option.value)
}

function onChange(option: { value: string }, checked: boolean): void {
  if (props.mode === 'radio') {
    emit('update:modelValue', option.value)
    return
  }
  const next = checked
    ? [...props.modelValues, option.value]
    : props.modelValues.filter((v) => v !== option.value)
  emit('update:modelValues', next)
}
</script>

<template>
  <div class="u-cc-group" role="group" :aria-label="label">
    <label
      v-for="option in options"
      :key="option.value"
      ref="cardEls"
      class="u-cc"
      :class="{ 'u-cc-selected': isSelected(option), 'u-cc-disabled': option.disabled || disabled }"
    >
      <input
        class="u-cc-input"
        :type="mode"
        :name="mode === 'radio' ? name : undefined"
        :value="option.value"
        :checked="isSelected(option)"
        :disabled="option.disabled || disabled"
        @change="onChange(option, ($event.target as HTMLInputElement).checked)"
      >
      <span :key="String(isSelected(option))" class="u-cc-mark" :class="mode === 'radio' ? 'u-cc-mark-radio' : 'u-cc-mark-checkbox'" aria-hidden="true">
        <Check v-if="mode === 'checkbox'" class="u-cc-check" :size="14" aria-hidden="true" />
      </span>
      <span class="u-cc-body">
        <strong class="u-cc-title">{{ option.title }}</strong>
        <span v-if="option.description" class="u-cc-desc">{{ option.description }}</span>
      </span>
    </label>
  </div>
</template>

<style scoped>
.u-cc-group {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
}
.u-cc {
  display: flex;
  gap: var(--unself-space-3);
  align-items: flex-start;
  padding: var(--unself-space-3);
  background: var(--unself-color-surface);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  cursor: pointer;
  transition:
    border-color var(--unself-duration-fast) var(--unself-ease-out),
    background var(--unself-duration-fast) var(--unself-ease-out),
    transform var(--unself-duration-fast) var(--unself-ease-out);
}
.u-cc:hover {
  border-color: var(--unself-color-primary);
  transform: translateY(calc(-1 * var(--unself-motion-lift-y)));
}
.u-cc-selected {
  border-color: var(--unself-color-primary);
  background: var(--unself-color-primary-soft);
}
.u-cc-disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
}

.u-cc-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.u-cc-mark {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: var(--unself-space-5);
  height: var(--unself-space-5);
  margin-top: 2px;
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-sm);
  background: var(--unself-color-surface);
  color: var(--unself-color-surface);
  transition:
    background var(--unself-duration-fast) var(--unself-ease-out),
    border-color var(--unself-duration-fast) var(--unself-ease-out),
    transform var(--unself-duration-fast) var(--unself-ease-spring);
}
.u-cc-mark-radio {
  border-radius: var(--unself-radius-full);
}
.u-cc-input:checked + .u-cc-mark {
  border-color: var(--unself-color-primary);
  background: var(--unself-color-primary);
  /* 选中回弹 = 1/press-scale（与 motion.ts popVariants 同一契约参数，CSS 侧用 calc 推导） */
  transform: scale(calc(1 / var(--unself-motion-press-scale)));
}
.u-cc-mark-radio::after {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: var(--unself-radius-full);
  background: var(--unself-color-surface);
  transform: scale(0);
  transition: transform var(--unself-duration-fast) var(--unself-ease-spring);
}
.u-cc-input:checked + .u-cc-mark-radio::after {
  transform: scale(1);
}
.u-cc-check {
  width: 14px;
  height: 14px;
  opacity: 0;
  /* 未选初始缩进 = press-scale（勾选到 1 的 pop，与卡指示同一令牌家族） */
  transform: scale(var(--unself-motion-press-scale));
  transition:
    opacity var(--unself-duration-fast) var(--unself-ease-out),
    transform var(--unself-duration-fast) var(--unself-ease-spring);
}
.u-cc-input:checked + .u-cc-mark .u-cc-check {
  opacity: 1;
  transform: scale(1);
}
/* reduced-motion：入场变体已 duration 0；这里的 transform 过渡同步关 */
.u-cc-input:focus-visible + .u-cc-mark {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}
.u-cc-body {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
  min-width: 0;
}
.u-cc-title {
  font-size: var(--unself-font-size-base);
  color: var(--unself-color-text);
}
.u-cc-desc {
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
@media (prefers-reduced-motion: reduce) {
  .u-cc,
  .u-cc-mark,
  .u-cc-mark-radio::after,
  .u-cc-check {
    transition: none;
    transform: none;
  }
}
</style>
