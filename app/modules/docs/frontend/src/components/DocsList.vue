<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 文档列表页（D8）：只负责画状态 + 转发事件，逻辑全在 lib/docs-list-state.ts。
 *
 * 权限纪律：viewer 不显示「删除」按钮，但这只是界面映射——服务端仍按角色裁决
 * （owner 才能删）。前端藏按钮不是权限。
 */
import { computed } from 'vue'

import UButton from '@unself/ui/button'
import UBanner from '@unself/ui/banner'
import USkeleton from '@unself/ui/skeleton'

import type { ListState } from '../lib/docs-list-state'
import { errorText, type Doc } from '../lib/docs-types'

const props = defineProps<{
  state: ListState
  /** 当前用户 id：用来在条目上标「我的」。 */
  meId: string
}>()

const emit = defineEmits<{
  open: [id: string]
  create: []
  delete: [id: string]
  retry: []
  loadMore: []
}>()

const isFirstLoad = computed(() => props.state.status === 'loading' && props.state.items.length === 0)
const isEmpty = computed(
  () => props.state.status === 'ready' && props.state.error === null && props.state.items.length === 0,
)
const hasError = computed(() => props.state.error !== null)
const errorMessage = computed(() =>
  props.state.error === null ? '' : errorText(props.state.error),
)

/** 只有 owner 能删（服务端仍会再判一次）。 */
function canDelete(doc: Doc): boolean {
  return doc.role === 'owner'
}

function isMine(doc: Doc): boolean {
  return doc.ownerId === props.meId
}

function formatTime(iso: string): string {
  const time = new Date(iso)
  return Number.isNaN(time.getTime())
    ? iso
    : time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

function confirmDelete(doc: Doc): void {
  if (!canDelete(doc)) return
  // 二次确认：删除不可撤销（软删对用户来说同样是消失）
  const ok = globalThis.confirm(`删除「${doc.title}」？删除后不可恢复。`)
  if (ok) emit('delete', doc.id)
}
</script>

<template>
  <section class="docs-list" data-test="docs-list">
    <header class="head">
      <h1 class="title">文档</h1>
      <UButton data-test="create" @click="emit('create')">新建文档</UButton>
    </header>

    <UBanner v-if="hasError" tone="danger" class="banner" data-test="list-error">
      {{ errorMessage }}
      <UButton variant="outline" size="sm" data-test="retry" @click="emit('retry')">
        重试
      </UButton>
    </UBanner>

    <USkeleton v-if="isFirstLoad" :lines="3" data-test="list-loading" />

    <p v-else-if="isEmpty" class="empty" data-test="list-empty">
      还没有文档。点「新建文档」写第一篇。
    </p>

    <ul v-else class="items">
      <li v-for="doc in state.items" :key="doc.id" class="item" :data-test="`doc-${doc.id}`">
        <button type="button" class="open" :aria-label="`打开 ${doc.title}`" @click="emit('open', doc.id)">
          <span class="item-title">{{ doc.title }}</span>
          <span class="item-meta">
            {{ formatTime(doc.updatedAt) }}
            <span v-if="isMine(doc)" class="badge">我的</span>
            <span v-if="doc.role === 'viewer'" class="badge">只读</span>
          </span>
        </button>
        <UButton
          v-if="canDelete(doc)"
          variant="outline"
          size="sm"
          class="danger"
          data-test="delete"
          :disabled="state.deleting.includes(doc.id)"
          @click="confirmDelete(doc)"
        >
          {{ state.deleting.includes(doc.id) ? '删除中…' : '删除' }}
        </UButton>
      </li>
    </ul>

    <UButton
      v-if="state.hasMore"
      variant="outline"
      size="sm"
      class="more"
      data-test="load-more"
      :disabled="state.status === 'loading'"
      @click="emit('loadMore')"
    >
      {{ state.status === 'loading' ? '加载中…' : '加载更多' }}
    </UButton>
  </section>
</template>

<style scoped>
.docs-list {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-4);
  height: 100%;
  padding: var(--unself-space-6);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-4);
}
.title {
  margin: 0;
  font-size: var(--unself-font-size-xl);
  font-weight: 600;
  color: var(--unself-color-text);
}
/* UBanner 自带 margin-bottom，列表已用 gap 排版，这里清零。
   父选择器抬一级：与基元同为单类 + scope 属性时，胜负会落在产物顺序上。 */
.docs-list .banner {
  margin-bottom: 0;
}
.empty {
  margin: 0;
  padding: var(--unself-space-8) 0;
  text-align: center;
  color: var(--unself-color-text-secondary);
}
.items {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.item {
  display: flex;
  align-items: center;
  gap: var(--unself-space-3);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg);
  padding-right: var(--unself-space-3);
}
.item:hover {
  background: var(--unself-color-surface);
}
.open {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
  padding: var(--unself-space-3) var(--unself-space-4);
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  color: var(--unself-color-text);
}
.item-title {
  font-size: var(--unself-font-size-base);
  font-weight: 500;
}
.item-meta {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
  font-variant-numeric: tabular-nums;
}
.badge {
  padding: 0 var(--unself-space-2);
  border-radius: var(--unself-radius-sm);
  background: var(--unself-color-surface-active);
  font-size: var(--unself-font-size-sm);
}
/*
 * 删除按钮做成胶囊：UButton 的圆角/配色在自身 scoped 块里，与这里的类同特异性，
 * 胜负看产物先后；用父选择器抬一级才压得住。红字压在列表底色(#faf9f7)上 4.6:1，
 * 换成 danger 变体是 danger-soft 底配红字，只有 3.96:1，过不了 AA。
 */
.item .danger {
  border-color: var(--unself-color-danger);
  border-radius: var(--unself-radius-full);
  color: var(--unself-color-danger);
}
.item .danger:hover:not(:disabled) {
  border-color: var(--unself-color-danger);
  color: var(--unself-color-danger);
}
.more {
  align-self: center;
}
@media (prefers-reduced-motion: reduce) {
  * {
    transition: none;
    animation: none;
  }
}
</style>
