<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 水舱弹窗壳（#100 外壳的共用化，#349 消融实验抽出）：遮罩 + dialog 壳 + 标题栏/关闭钮 + 焦点三契约 + 装饰水面。
 *
 * settings-config-dialog / add-module-dialog 的壳原本两写：遮罩、壳框、标题栏、✕、WaveFill 装饰层、
 * 内容抬层 z-index、入场动画与 reduced-motion 降级完全同构；焦点三契约（开焦点入内 / 关焦点回归 /
 * Esc 关）本就走共用的 use-layer-focus。本组件把这些收成一处，供两个弹窗共用。
 *
 * - 焦点/Esc 走 use-layer-focus（#192 F5）：open 是可写 computed，Esc 关闭写回 v-model
 *   （ConfirmDialog 注释同款：只读 computed 会让 Esc 静默失效）。
 * - 字段与主动作由默认 slot 注入；水面 level 由父级按各自测试态派生传入（WaveFill 恒 aria-hidden）。
 * - slot 内容归父作用域，各弹窗自己给内容块抬层（relative z-1）压水面；壳只提供结构与标题栏抬层。
 * - 样式全 tokens；动画参数从 tokens 取；reduced-motion 降级归零。
 */
import { computed, ref } from 'vue'

import WaveFill from './wave-fill.vue'
import { useLayerFocus } from '../lib/use-layer-focus'

const props = withDefaults(
  defineProps<{
    /** 弹层开合（v-model）。 */
    modelValue: boolean
    /** 标题（dialog 的 aria-label 与标题栏文本）。 */
    title: string
    /** data-test 锚点名：壳 = `${name}`，关闭钮 = `${closeName ?? `${name}-close`}`（settings 既有夹具是不带 domain 的 settings-dialog-close，故可覆写）。 */
    name: string
    closeName?: string
    /** 装饰水位：rest 基线 / testing 测潮 / full 满灌（#100 语义，WaveFill 原样）。 */
    level?: 'rest' | 'testing' | 'full'
    /** 壳宽上限（min(上限, 100%)），默认 520px 对齐设置弹窗；add 弹窗传 560px。 */
    maxWidth?: string
  }>(),
  {
    level: 'rest',
    maxWidth: '520px',
  },
)

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
}>()

const layerEl = ref<HTMLElement | null>(null)

/** 可写 computed（ConfirmDialog 同款）：useLayerFocus 的 Esc 关闭走 open.value = false。 */
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})

const { onKeydown } = useLayerFocus(open, () => layerEl.value)

function close(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <div v-if="modelValue" class="aqua-dialog-scrim" @click.self="close" @keydown="onKeydown">
    <section
      ref="layerEl"
      class="aqua-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
      :data-test="name"
      :style="{ '--aqua-dialog-max-w': maxWidth }"
      @click.stop
    >
      <header class="aqua-dialog-head">
        <h2 class="aqua-dialog-title">{{ title }}</h2>
        <button type="button" class="aqua-dialog-close" aria-label="关闭" :data-test="closeName ?? `${name}-close`" @click="close">
          ✕
        </button>
      </header>

      <!-- 字段/业务区由弹窗自己注入；内容块需自带抬层（relative z-1）压水面 -->
      <slot />

      <!-- 装饰水面（纯装饰，恒 aria-hidden）：内容层 z-index 压在其上 -->
      <WaveFill :level="level" />
    </section>
  </div>
</template>

<style scoped>
.aqua-dialog-scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-4);
  background: var(--unself-color-scrim);
}
.aqua-dialog {
  /* 组件私有默认宽：maxWidth prop 经 :style 覆写（同文件内联声明，verify:tokens 规则二放行） */
  --aqua-dialog-max-w: 520px;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-4);
  width: min(var(--aqua-dialog-max-w), 100%);
  max-height: calc(100vh - var(--unself-space-8));
  overflow: hidden;
  padding: var(--unself-space-6);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  background: var(--unself-color-surface);
  box-shadow: var(--unself-shadow-pop);
  animation: aqua-dialog-in var(--unself-duration-normal) var(--unself-ease-out);
}
.aqua-dialog:focus {
  outline: none;
}
@keyframes aqua-dialog-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
/* 水舱装饰层 WaveFill 绝对铺满整个弹窗（inset: 0）；内容块必须显式抬层，否则满灌时被水盖住。
 * slot 内容归父组件作用域，抬层类由各弹窗自己的 scoped CSS 负责（壳只提供结构）。 */
.aqua-dialog-head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-3);
}
.aqua-dialog-title {
  margin: 0;
  font-size: var(--unself-font-size-lg);
  font-weight: 600;
  color: var(--unself-color-text);
}
.aqua-dialog-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: var(--unself-radius-md);
  background: transparent;
  color: var(--unself-color-text-tertiary);
  font-size: var(--unself-font-size-base);
  cursor: pointer;
}
.aqua-dialog-close:hover {
  background: var(--unself-color-surface-active);
  color: var(--unself-color-text);
}
.aqua-dialog-close:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .aqua-dialog {
    animation: none;
  }
}
</style>
