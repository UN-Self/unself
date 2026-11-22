<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

import { UButton, UMessageAvatar } from '@unself/ui'
import { useModalFocus } from '../lib/dialog-focus'
import type { Channel, UserSummary } from '../lib/types'

/**
 * 转发目标选择弹窗（#347）：Teleport 到 body 的模态卡片。Tab「群组 / 联系人」，
 * 搜索过滤、多选（群组=channels 已加入；联系人选中后由父层 openDm 解析 dm 房间）。
 * Esc / 遮罩 / 关闭钮三条关闭路径（ReadReceipts 同模式）。
 */
export interface ForwardTarget {
  kind: 'channel' | 'user'
  id: number
}

export interface ForwardDialogProps {
  /** 开关。 */
  open: boolean
  /** 逐条 / 合并（仅影响确认按钮文案与摘要行）。 */
  mode: 'single' | 'merged'
  /** 本次转发的消息条数（摘要行显示）。 */
  count: number
  channels?: Channel[]
  contacts?: UserSummary[]
  /** 提交中（防重复点击）。 */
  busy?: boolean
  /** 提交失败人话（父层持有）。 */
  error?: string
}

const props = withDefaults(defineProps<ForwardDialogProps>(), {
  channels: () => [],
  contacts: () => [],
  busy: false,
  error: '',
})

const emit = defineEmits<{
  close: []
  confirm: [targets: ForwardTarget[]]
}>()

const tab = ref<'groups' | 'contacts'>('groups')
const query = ref('')
/** 已选目标（channel.id 或 user.id）。 */
const selected = ref<ForwardTarget[]>([])

watch(() => props.open, (open) => {
  if (open) {
    tab.value = 'groups'
    query.value = ''
    selected.value = []
    focusOnOpen()
  } else {
    focusOnClose()
  }
})

// 焦点管理（#347 M2）：打开聚焦搜索框（卡内首个可聚焦元素）、Tab 圈禁、关闭还焦
const { setCardEl, onOpen: focusOnOpen, onClose: focusOnClose, trapTab } = useModalFocus(() => props.open)

const groupOptions = computed(() => props.channels.filter((channel) =>
  channel.isMember && `${channel.name} ${channel.description}`.toLowerCase().includes(query.value.trim().toLowerCase()),
))
const contactOptions = computed(() => props.contacts.filter((contact) =>
  `${contact.displayName} ${contact.username}`.toLowerCase().includes(query.value.trim().toLowerCase()),
))

function isSelected(target: ForwardTarget): boolean {
  return selected.value.some((item) => item.kind === target.kind && item.id === target.id)
}

function toggle(target: ForwardTarget): void {
  selected.value = isSelected(target)
    ? selected.value.filter((item) => !(item.kind === target.kind && item.id === target.id))
    : [...selected.value, target]
}

const modeLabel = computed(() => props.mode === 'merged' ? '合并转发' : '逐条转发')

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open && !props.busy) emit('close')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>
<template>
  <Teleport to="body">
    <div v-if="open" class="forward-layer" data-test="forward-overlay">
      <div class="forward-scrim" aria-hidden="true" @click="!busy && emit('close')" />
      <section :ref="setCardEl" class="forward-card" role="dialog" aria-modal="true" aria-label="转发" tabindex="-1" @keydown="trapTab">
        <header class="forward-head">
          <div>
            <p class="forward-eyebrow">{{ modeLabel }} · {{ count }} 条消息</p>
            <h2 class="forward-title">转发到</h2>
          </div>
          <button type="button" class="forward-close" data-test="forward-close" aria-label="关闭" :disabled="busy" @click="emit('close')">
            <X :size="18" aria-hidden="true" />
          </button>
        </header>

        <div class="forward-tabs" role="tablist">
          <button type="button" role="tab" :aria-selected="tab === 'groups'" class="forward-tab" :class="{ active: tab === 'groups' }" @click="tab = 'groups'">群组</button>
          <button type="button" role="tab" :aria-selected="tab === 'contacts'" class="forward-tab" :class="{ active: tab === 'contacts' }" @click="tab = 'contacts'">联系人</button>
        </div>
        <input v-model="query" class="forward-search" data-test="forward-search" aria-label="搜索" placeholder="搜索" />

        <div class="forward-options" data-test="forward-options">
          <template v-if="tab === 'groups'">
            <button
              v-for="channel in groupOptions"
              :key="`channel-${channel.id}`"
              type="button"
              class="forward-option"
              :class="{ selected: isSelected({ kind: 'channel', id: channel.id }) }"
              @click="toggle({ kind: 'channel', id: channel.id })"
            >
              <UMessageAvatar :name="channel.name" />
              <span class="forward-option-name">{{ channel.name }}</span>
              <span class="forward-check" aria-hidden="true">{{ isSelected({ kind: 'channel', id: channel.id }) ? '✓' : '' }}</span>
            </button>
            <p v-if="!groupOptions.length" class="forward-empty">没有匹配的群组</p>
          </template>
          <template v-else>
            <button
              v-for="contact in contactOptions"
              :key="`user-${contact.id}`"
              type="button"
              class="forward-option"
              :class="{ selected: isSelected({ kind: 'user', id: contact.id }) }"
              @click="toggle({ kind: 'user', id: contact.id })"
            >
              <UMessageAvatar :src="contact.avatarUrl" :name="contact.displayName || contact.username" />
              <span class="forward-option-name">{{ contact.displayName || contact.username }}</span>
              <span class="forward-check" aria-hidden="true">{{ isSelected({ kind: 'user', id: contact.id }) ? '✓' : '' }}</span>
            </button>
            <p v-if="!contactOptions.length" class="forward-empty">没有匹配的联系人</p>
          </template>
        </div>

        <p v-if="error" class="forward-error" role="alert">{{ error }}</p>
        <footer class="forward-actions">
          <button type="button" class="forward-secondary" :disabled="busy" @click="emit('close')">取消</button>
          <UButton type="button" size="md" data-test="forward-confirm" :disabled="selected.length === 0 || busy" @click="emit('confirm', [...selected])">
            发送（{{ selected.length }}）
          </UButton>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
<style scoped>
.forward-layer {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-4);
}
.forward-scrim { position: absolute; inset: 0; background: var(--unself-color-scrim); }
.forward-card {
  position: relative;
  width: min(400px, 100%);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  padding: var(--unself-space-4);
  background: var(--unself-color-bg);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  box-shadow: var(--unself-shadow-pop);
}
.forward-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--unself-space-2); }
.forward-eyebrow { margin: 0 0 var(--unself-space-1); color: var(--unself-color-text-tertiary); font-size: var(--unself-font-size-xs); font-weight: 600; }
.forward-title { margin: 0; font-size: var(--unself-font-size-lg); color: var(--unself-color-text); }
.forward-close {
  display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0;
  border: 0; border-radius: var(--unself-radius-md); background: transparent;
  color: var(--unself-color-text-secondary); cursor: pointer;
}
.forward-close:hover { background: var(--unself-color-surface-hover); }
.forward-tabs { display: flex; gap: var(--unself-space-2); margin: var(--unself-space-3) 0 var(--unself-space-2); }
.forward-tab {
  padding: var(--unself-space-1) var(--unself-space-3);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-full);
  background: transparent;
  color: var(--unself-color-text-secondary);
  font: inherit;
  font-size: var(--unself-font-size-sm);
  cursor: pointer;
}
.forward-tab.active { border-color: var(--unself-color-primary); color: var(--unself-color-primary); background: var(--unself-color-primary-soft); }
.forward-search {
  min-height: 36px; box-sizing: border-box; margin-bottom: var(--unself-space-2); padding: 0 var(--unself-space-2);
  border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg); color: var(--unself-color-text); font: inherit;
}
.forward-options { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--unself-space-1); }
.forward-option {
  display: flex; align-items: center; gap: var(--unself-space-2);
  padding: var(--unself-space-2); border: 1px solid transparent; border-radius: var(--unself-radius-md);
  background: transparent; color: var(--unself-color-text); font: inherit; text-align: left; cursor: pointer;
}
.forward-option:hover, .forward-option.selected { border-color: var(--unself-color-primary-soft); background: var(--unself-color-surface-active); }
.forward-option-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.forward-check { color: var(--unself-color-primary); font-weight: 700; }
.forward-empty { padding: var(--unself-space-3) 0; color: var(--unself-color-text-tertiary); font-size: var(--unself-font-size-sm); }
.forward-error { margin: var(--unself-space-2) 0 0; color: var(--unself-color-danger); font-size: var(--unself-font-size-sm); }
.forward-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--unself-space-3); margin-top: var(--unself-space-3); }
.forward-secondary {
  min-height: 40px; padding: 0 var(--unself-space-3);
  border: 0; border-radius: var(--unself-radius-md); background: transparent;
  color: var(--unself-color-text-secondary); font: inherit; cursor: pointer;
}
</style>
