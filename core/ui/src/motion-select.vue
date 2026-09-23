// SPDX-License-Identifier: AGPL-3.0-only
<script setup lang="ts">
import type { SelectOption, UMotionSelectProps } from './motion-select-types'
/**
 * 公共基元：选项下拉（§6.5 组件查找序① beUI「Morph Select」）。
 * 动效 = @vueuse/motion（v-motion 体系）真实接入：变体数值运行时取自契约令牌
 * （见 motion.ts），reduced-motion / 无 DOM 下降级 duration 0。
 * 无障碍（WAI-ARIA listbox 模式）：
 * - useId 生成多实例唯一 id；触发器 aria-controls 绑定面板 id，aria-expanded/aria-haspopup/aria-activedescendant；
 * - 开面板焦点落在当前选中项（无选中 → 第一项）；↑↓ 循环移动、Home/End、Enter/Space 选择、Esc 关闭还焦点；
 * - 点击外部关闭。
 * 图标：Lucide ChevronDown（禁手写 svg）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { useMotion } from '@vueuse/motion'
import { motionAvailable, panelVariants } from './motion'
import { nextInstanceId } from './instance-id'

const props = withDefaults(defineProps<UMotionSelectProps>(), {
  placeholder: '请选择',
  disabled: false,
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

// 多实例唯一 id（WAI-ARIA：aria-controls/aria-activedescendant 必须指向真实 DOM id）
const panelId = `u-motion-select-panel-${nextInstanceId()}`

const open = ref(false)
const triggerEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
/** 键盘焦点位（roving；-1 = 焦点在触发器）。 */
const activeIndex = ref(-1)

const selected = computed(() => props.options.find((o) => o.value === props.modelValue) ?? null)
const triggerText = computed(() => selected.value?.label ?? props.placeholder)
/** 当前活动项（aria-activedescendant 指向；键盘索引与视觉/读屏一致）。 */
const activeOption = computed(() => props.options[activeIndex.value] ?? null)

function optionId(index: number): string {
  return `${panelId}-opt-${index}`
}

function setOpen(next: boolean): void {
  if (props.disabled) return
  open.value = next
  if (!next) {
    activeIndex.value = -1
    triggerEl.value?.focus()
  }
}

async function toggle(): Promise<void> {
  if (open.value) {
    setOpen(false)
    return
  }
  // 开面板：活动位 = 当前选中项（无选中 → 第一项），焦点与 aria-activedescendant 对位
  const selectedIdx = props.options.findIndex((o) => o.value === props.modelValue)
  activeIndex.value = selectedIdx >= 0 ? selectedIdx : 0
  open.value = true
  await nextTick()
  // v-if 挂载 → watch(panelEl) 已建实例；显式从 initial 过渡到 enter（开合可重放）
  panelMotion.value?.apply('enter')
  focusOption(activeIndex.value)
}

function choose(option: SelectOption): void {
  emit('update:modelValue', option.value)
  setOpen(false)
}

function move(delta: number): void {
  if (props.options.length === 0) return
  const n = props.options.length
  activeIndex.value = (((activeIndex.value + delta) % n) + n) % n
  focusOption(activeIndex.value)
}

function focusOption(index: number): void {
  panelEl.value?.querySelectorAll<HTMLElement>('[role=option]')[index]?.focus()
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    void toggle()
    return
  }
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    setOpen(false)
  }
}

function onPanelKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    activeIndex.value = 0
    focusOption(0)
  } else if (event.key === 'End') {
    event.preventDefault()
    activeIndex.value = props.options.length - 1
    focusOption(props.options.length - 1)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    setOpen(false)
  } else if (event.key === 'Enter' || event.key === ' ') {
    // 选项是原生 button：默认 click 已选择，这里只阻止表单误提交
    event.preventDefault()
    ;(event.target as HTMLElement).click()
  }
}

function onDocumentPointerdown(event: PointerEvent): void {
  const root = triggerEl.value?.parentElement
  if (!root || !open.value) return
  if (!root.contains(event.target as Node)) setOpen(false)
}

/**
 * v-motion：面板开合变体（令牌驱动；reduced-motion → duration 0）。
 * 面板是 v-if=open 的响应式挂载 → 用 watch(panelEl) 在真挂载时建 useMotion 实例并应用 initial，
 * 每次开合经 apply('enter') 从 initial 过渡（拆卸即随 v-if 销毁，重开重建重放）。
 */
const panelMotion = ref<{ apply: (variant: string) => void } | null>(null)

watch(panelEl, (el) => {
  if (el && motionAvailable()) {
    panelMotion.value = useMotion(el, panelVariants())
  } else {
    panelMotion.value = null
  }
})

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerdown)
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerdown))
</script>

<template>
  <div class="u-ms">
    <button
      ref="triggerEl"
      type="button"
      class="u-ms-trigger"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="panelId"
      :aria-activedescendant="open && activeOption ? optionId(activeIndex) : undefined"
      :disabled="disabled"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="u-ms-value">{{ triggerText }}</span>
      <ChevronDown class="u-ms-chevron" :class="{ 'u-ms-chevron-open': open }" :size="16" aria-hidden="true" />
    </button>
    <div
      v-if="open"
      :id="panelId"
      ref="panelEl"
      class="u-ms-panel"
      role="listbox"
      :aria-label="label"
      @keydown="onPanelKeydown"
    >
      <button
        v-for="(option, i) in options"
        :id="optionId(i)"
        :key="option.value"
        type="button"
        role="option"
        class="u-ms-option"
        :aria-selected="option.value === modelValue"
        @click="choose(option)"
      >
        {{ option.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.u-ms {
  position: relative;
  width: 100%;
  min-width: 0;
}
.u-ms-trigger {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-2);
  min-height: 40px;
  padding: 0 var(--unself-space-3);
  font: inherit;
  color: var(--unself-color-text);
  background: var(--unself-color-bg);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  text-align: left;
  transition: border-color var(--unself-duration-fast) var(--unself-ease-out);
}
.u-ms-trigger:hover:not(:disabled) {
  border-color: var(--unself-color-primary);
}
.u-ms-trigger:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
  border-color: var(--unself-color-primary);
}
.u-ms-trigger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.u-ms-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.u-ms-chevron {
  flex: none;
  color: var(--unself-color-text-tertiary);
  transition: transform var(--unself-duration-fast) var(--unself-ease-spring);
}
.u-ms-chevron-open {
  transform: rotate(180deg);
}

/* beUI Morph Select 语义：面板=触发器的连续变体；数值运动交给 v-motion（motion.ts 令牌驱动），
   这里只留静态外观（位置/边框/阴影）。 */
.u-ms-panel {
  position: absolute;
  z-index: 2;
  top: calc(100% + var(--unself-space-1));
  left: 0;
  right: 0;
  max-height: 14rem;
  overflow: auto;
  padding: var(--unself-space-1);
  background: var(--unself-color-surface);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  box-shadow: var(--unself-shadow-pop);
}
.u-ms-option {
  display: block;
  width: 100%;
  padding: var(--unself-space-2) var(--unself-space-3);
  font: inherit;
  color: var(--unself-color-text);
  background: transparent;
  border: 0;
  border-radius: var(--unself-radius-sm);
  text-align: left;
}
.u-ms-option + .u-ms-option {
  margin-top: 2px;
}
.u-ms-option:hover {
  background: var(--unself-color-surface-hover);
}
.u-ms-option:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: -2px;
  background: var(--unself-color-surface-hover);
}
.u-ms-option[aria-selected='true'] {
  color: var(--unself-color-primary);
  background: var(--unself-color-primary-soft);
  font-weight: 600;
}
@media (prefers-reduced-motion: reduce) {
  .u-ms-chevron {
    transition: none;
  }
}
</style>
