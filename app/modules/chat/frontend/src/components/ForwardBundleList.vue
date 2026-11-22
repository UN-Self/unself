<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { provide, ref } from 'vue'

import ForwardBundleView from './ForwardBundleView.vue'
import MessageContent from './MessageContent.vue'
import { attachmentResourceKey } from '../lib/attachment-resource'
import { formatMessageTime } from '../lib/message-time'
import type { ForwardBundleEntry, Message, MessageBlock } from '../lib/types'

/**
 * 合并转发条目列表（#347）：条目本身是「合并转发」（blocks 里带 forward_bundle，即套娃）时，
 * 与主会话同款——渲染摘要卡，点击弹出下一层浮层查看（不再内联平铺展开）。
 */
defineProps<{ messages: ForwardBundleEntry[] }>()

// 断开对外的 attachmentResourceKey 继承：本浮层挂在 MessageBubble 组件树内（Teleport 不断
// provide/inject 链），不显式置 null 的话，条目附件会拿到外层气泡绑在「卡片本体消息」上的
// 共享 resource（attachment 恒为 null）——加载/下载全部静默空转（实测踩坑：点附件无任何反应）。
// 置 null 后条目内 MessageAttachment 回退到自带 useAttachmentResource（走全局 loader，带 token）。
provide(attachmentResourceKey, null)

/** 条目内嵌的 forward_bundle（套娃），无则 null。 */
function bundleOf(entry: ForwardBundleEntry): Extract<MessageBlock, { type: 'forward_bundle' }> | null {
  const found = entry.blocks?.find((block) => block.type === 'forward_bundle')
  return found && found.type === 'forward_bundle' ? found : null
}

/** 套娃摘要卡：点击开下一层浮层（本组件局部状态；每层一个 ForwardBundleView 实例）。 */
const nestedOpen = ref<Extract<MessageBlock, { type: 'forward_bundle' }> | null>(null)

/** 条目 → Message 合成：复用 MessageContent 渲染正文/附件（图片预览、语音、下载同正常气泡）。 */
function asMessage(entry: ForwardBundleEntry, index: number): Message {
  return {
    id: -(index + 1), // 浮层内合成消息不进消息流，取负数避开真实 id
    content: entry.content,
    mentionUserIds: [],
    mentions: [],
    createdAt: entry.createdAt,
    source: 'edgechat',
    sender: { kind: 'local', id: 0, username: '', displayName: entry.senderName, avatarUrl: '', source: 'edgechat' },
    attachment: entry.attachment ?? null,
    blocks: entry.blocks ?? undefined,
  }
}
</script>
<template>
  <ul class="bundle-list" data-test="forward-bundle-list">
    <li v-for="(entry, index) in messages" :key="index" class="bundle-item" data-test="forward-bundle-item">
      <div class="bundle-item-meta">
        <span class="bundle-item-author">{{ entry.senderName }}</span>
        <time class="bundle-item-time">{{ formatMessageTime(entry.createdAt) }}</time>
      </div>
      <div class="bundle-item-body">
        <!-- 引用卡（#347 反馈③）：与正常聊天引用块同款（左竖条 + 作者行 + 截断原文），不可点 -->
        <div v-if="entry.reply" class="bundle-item-reply" data-test="forward-bundle-reply">
          <span v-if="entry.reply.authorName" class="bundle-item-reply-author">{{ entry.reply.authorName }}</span>
          <span class="bundle-item-reply-text">{{ entry.reply.deleted ? '原消息已删除' : entry.reply.text }}</span>
        </div>
        <!-- 套娃：条目本身是合并转发 → 摘要卡（与主会话气泡同款样式），点击弹下一层浮层 -->
        <button
          v-if="bundleOf(entry)"
          type="button"
          class="bundle-nested-card"
          data-test="forward-bundle-nested"
          @click="nestedOpen = bundleOf(entry)"
        >
          <span class="bundle-nested-text">[聊天记录] {{ bundleOf(entry)?.count }} 条消息</span>
        </button>
        <!-- 正文/附件走 MessageContent：图片预览、语音播放、附件下载与正常气泡同一套 -->
        <MessageContent v-else :message="asMessage(entry, index)" />
      </div>
    </li>
  </ul>
  <!-- 套娃下一层浮层：Teleport 到 body，与上层叠加（Esc 只关最上层，见 ForwardBundleView） -->
  <ForwardBundleView
    :open="nestedOpen !== null"
    :messages="nestedOpen?.messages ?? []"
    @close="nestedOpen = null"
  />
</template>
<style scoped>
.bundle-list {
  list-style: none;
  margin: 0;
  padding: var(--unself-space-3) var(--unself-space-4) var(--unself-space-4);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
}
.bundle-item-meta {
  display: flex;
  align-items: baseline;
  gap: var(--unself-space-2);
  margin-bottom: 2px;
}
.bundle-item-author { font-size: var(--unself-font-size-sm); font-weight: 500; color: var(--unself-color-text-secondary); }
.bundle-item-time { font-size: var(--unself-font-size-2xs); color: var(--unself-color-text-tertiary); font-variant-numeric: tabular-nums; }
.bundle-item-body { display: flex; flex-direction: column; gap: var(--unself-space-1); }
.bundle-item-reply {
  padding: var(--unself-space-1) var(--unself-space-2);
  border-left: 2px solid var(--unself-color-border);
  border-radius: 0 var(--unself-radius-sm) var(--unself-radius-sm) 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.bundle-item-reply-author { display: block; font-size: var(--unself-font-size-xs); margin-bottom: 1px; }
.bundle-item-reply-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
  overflow: hidden;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* 套娃摘要卡：与主会话气泡 forward 卡同族（左竖条 + tinted 底，整卡可点开下一层浮层） */
.bundle-nested-card {
  display: block;
  width: 100%;
  padding: var(--unself-space-1) var(--unself-space-2);
  border: 0;
  border-left: 2px solid var(--unself-color-primary);
  border-radius: 0 var(--unself-radius-sm) var(--unself-radius-sm) 0;
  background: transparent;
  color: var(--unself-color-text-secondary);
  font: inherit;
  font-size: var(--unself-font-size-sm);
  text-align: left;
  cursor: pointer;
}
.bundle-nested-card:hover { background: color-mix(in srgb, var(--unself-color-text) 8%, transparent); }
.bundle-nested-card:focus-visible { outline: var(--unself-focus-ring); outline-offset: 2px; }
.bundle-nested-text { display: block; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>