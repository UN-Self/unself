<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- 模块级层栈（全部实例共享）：套娃多层同时挂着时，Esc 只关最上层，避免一次全关。
     必须放普通 <script>（模块作用域）——<script setup> 的代码每个实例各跑一遍，拿不到共享。 -->
<script lang="ts">
const openLayers: symbol[] = []
</script>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { X } from 'lucide-vue-next'

import ForwardBundleList from './ForwardBundleList.vue'
import { useModalFocus } from '../lib/dialog-focus'
import type { ForwardBundleEntry } from '../lib/types'

/**
 * 合并转发内容浮层（#347）：Teleport 到 body 的模态卡片，逐条平铺源消息；
 * 套娃时经 ForwardBundleList 的摘要卡再开一层本浮层（层层叠加）。
 * Esc / 遮罩 / 关闭钮三条关闭路径（ReadReceipts 同模式）。
 */
export interface ForwardBundleViewProps {
  /** 合并转发源消息（forward_bundle.blocks[0].messages）。 */
  messages: ForwardBundleEntry[]
  /** 开关（父层持有）。 */
  open: boolean
}

const props = defineProps<ForwardBundleViewProps>()

const emit = defineEmits<{
  /** 任一关闭路径（Esc/遮罩/关闭钮）触发。 */
  close: []
}>()

// 打开层栈（见文件顶部模块级 openLayers）：Esc 只关最上层，避免一次全关
const layerId = Symbol('forward-bundle-layer')

// 焦点管理（#347 M2）：打开聚焦卡内（无输入框，首聚焦元素即关闭钮）、Tab 圈禁、关闭还焦
const { setCardEl, onOpen: focusOnOpen, onClose: focusOnClose, trapTab } = useModalFocus(() => props.open)

watch(
  () => props.open,
  (open) => {
    if (open) {
      openLayers.push(layerId)
      focusOnOpen()
    } else {
      const index = openLayers.indexOf(layerId)
      if (index >= 0) openLayers.splice(index, 1)
      focusOnClose()
    }
  },
)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open && openLayers.at(-1) === layerId) emit('close')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  const index = openLayers.indexOf(layerId)
  if (index >= 0) openLayers.splice(index, 1)
})
</script>
<template>
  <Teleport to="body">
    <div v-if="open" class="bundle-layer" data-test="forward-bundle-overlay">
      <div class="bundle-scrim" aria-hidden="true" @click="emit('close')" />
      <section :ref="setCardEl" class="bundle-card" role="dialog" aria-modal="true" aria-label="聊天记录" tabindex="-1" @keydown="trapTab">
        <header class="bundle-head">
          <span class="bundle-title" data-test="forward-bundle-title">聊天记录（{{ messages.length }} 条）</span>
          <button type="button" class="bundle-close" data-test="forward-bundle-close" aria-label="关闭" @click="emit('close')">
            <X :size="16" aria-hidden="true" />
          </button>
        </header>
        <ForwardBundleList :messages="messages" />
      </section>
    </div>
  </Teleport>
</template>
<style scoped>
.bundle-layer {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-4);
}
.bundle-scrim {
  position: absolute;
  inset: 0;
  background: var(--unself-color-scrim);
}
.bundle-card {
  position: relative;
  width: min(420px, 100%);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--unself-color-bg);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  box-shadow: var(--unself-shadow-pop);
}
.bundle-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-2);
  padding: var(--unself-space-3) var(--unself-space-4);
  border-bottom: 1px solid var(--unself-color-border);
}
.bundle-title {
  font-size: var(--unself-font-size-base);
  font-weight: 600;
  color: var(--unself-color-text);
}
.bundle-close {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--unself-radius-md);
  background: transparent;
  color: var(--unself-color-text-secondary);
  cursor: pointer;
}
.bundle-close:hover { background: var(--unself-color-surface-hover); }
</style>