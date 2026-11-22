<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { Copy, Image, Undo2, Download, MessageSquareQuote, Forward, ListChecks } from 'lucide-vue-next'
import { UContextMenu, type MenuAction } from '@unself/ui'
import { attachmentResourceKey } from '../lib/attachment-resource'
import type { Message } from '../lib/types'
const props = defineProps<{ message: Message; canDelete: boolean }>()
const emit = defineEmits<{ delete: []; preview: []; quote: []; forward: []; 'multi-select': [] }>()
const resource = inject(attachmentResourceKey, null)
const status = ref('')
watch(() => [props.message.id, props.message.deleted], () => { status.value = '' })
const items = computed<MenuAction[]>(() => {
  if (props.message.deleted) return []
  const actions: MenuAction[] = []
  // 引用：所有未删除消息都可引用（纯附件消息引用块回退到附件名，见 reply-preview.ts）
  actions.push({ id: 'quote', label: '引用', icon: MessageSquareQuote })
  // #347 转发：直达单条转发；多选：进入消息流多选模式（底部操作条再选逐条/合并）
  actions.push({ id: 'forward', label: '转发', icon: Forward })
  actions.push({ id: 'multi-select', label: '多选', icon: ListChecks })
  // #347 合并转发消息不出「复制文本」：content 是「[聊天记录] N 条消息」摘要，复制它没有意义
  const isBundle = props.message.blocks?.some((block) => block.type === 'forward_bundle') === true
  if (props.message.content && !isBundle) actions.push({ id: 'copy', label: '复制文本', icon: Copy })
  const attachment = props.message.attachment
  if (attachment) {
    if (attachment.type.toLowerCase().startsWith('image/')) actions.push({ id: 'preview', label: '预览图片', icon: Image })
    actions.push({ id: 'download', label: '下载附件', icon: Download })
  }
  if (props.canDelete) actions.push({ id: 'delete', label: '撤回', icon: Undo2, destructive: true })
  return actions
})
async function select(id: string) {
  if (props.message.deleted) return
  status.value = ''
  if (id === 'delete' && props.canDelete) { emit('delete'); return }
  if (id === 'quote') { emit('quote'); return }
  if (id === 'forward') { emit('forward'); return }
  if (id === 'multi-select') { emit('multi-select'); return }
  if (id === 'preview') { emit('preview'); return }
  if (id === 'download' && props.message.attachment) {
    await resource?.download()
    if (resource?.failed.value) status.value = '下载失败，请重试'
    return
  }
  if (id !== 'copy') return
  const messageId = props.message.id
  try {
    await navigator.clipboard.writeText(props.message.content)
    if (props.message.id === messageId && !props.message.deleted) status.value = '已复制'
  } catch {
    if (props.message.id === messageId && !props.message.deleted) status.value = '复制失败，请允许浏览器访问剪贴板后重试'
  }
}
</script>
<template>
  <UContextMenu :items="items" :disabled="message.deleted" @select="select"><slot /></UContextMenu>

  <span v-if="status" role="status" class="action-status">{{ status }}</span>
</template>
<style scoped>
.action-status { color:var(--unself-color-text-secondary); font-size:var(--unself-font-size-xs); }
</style>
