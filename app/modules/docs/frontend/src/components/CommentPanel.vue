<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

import { X } from 'lucide-vue-next'

import UButton from '@unself/ui/button'

import type { CommentsApi, DocComment } from '../lib/docs-api-mock'

/**
 * D10 评论面板（加分项，主线验收通过后再上）。
 *
 * 现状说明：评论的 REST 端点还没进 D5 的契约表（后端只建了 docs_document_comments 表），
 * 所以这里**只用注入的 CommentsApi**，路径与形状都留在 lib 里一处可改。
 * 表结构已经确定：id / doc_id / author_id / body / created_at / deleted_at（软删）。
 */
const props = defineProps<{
  docId: string
  api: CommentsApi
  /** 当前用户 id：删除按钮只在自己的评论上出现（API 侧仍有裁决，这只是界面映射）。 */
  meId: string
  /** 从编辑器带过来的「引用所选」文本；null/空表示没有引用。 */
  quote?: string | null
}>()

const emit = defineEmits<{ clear: [] }>()

const comments = ref<DocComment[]>([])
const body = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
/** 引用到达时要滚到输入框并聚焦，不然在窄窗口里用户看不到任何反馈。 */
const composeEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)

watch(
  () => props.quote,
  (next) => {
    if (next == null || next.trim() === '') return
    composeEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    inputEl.value?.focus()
  },
)

async function load(id: string): Promise<void> {
  loading.value = true
  error.value = null
  try {
    comments.value = await props.api.listComments(id)
  } catch {
    error.value = '评论加载失败，接口可能还没上线（D5）。'
  } finally {
    loading.value = false
  }
}

onMounted(() => void load(props.docId))
watch(
  () => props.docId,
  (next) => void load(next),
)

function canDelete(comment: DocComment): boolean {
  return comment.authorId === props.meId && comment.deletedAt == null
}

async function submit(): Promise<void> {
  const text = body.value.trim()
  if (text === '' || loading.value) return
  const quote = props.quote?.trim() ?? ''
  const full = quote === '' ? text : `> ${quote}\n\n${text}`
  try {
    const created = await props.api.addComment(props.docId, full)
    comments.value = [...comments.value, created]
    body.value = ''
    emit('clear')
  } catch {
    error.value = '评论发送失败。'
  }
}

async function remove(id: string): Promise<void> {
  try {
    await props.api.deleteComment(props.docId, id)
    // 软删：本地同步打占位标记，不把行扔掉（与列表口径一致）
    comments.value = comments.value.map((item) =>
      item.id === id ? { ...item, deletedAt: new Date().toISOString() } : item,
    )
  } catch {
    error.value = '评论删除失败。'
  }
}

function dismissQuote(): void {
  emit('clear')
}

function formatTime(iso: string): string {
  const time = new Date(iso)
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <aside class="comments" data-test="comment-panel">
    <header>
      <h3>评论</h3>
      <span class="count">{{ comments.length }}</span>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <ul class="list">
      <li v-for="comment in comments" :key="comment.id">
        <div class="meta">
          <span class="author">{{ comment.authorName }}</span>
          <time>{{ formatTime(comment.createdAt) }}</time>
          <button
            v-if="canDelete(comment)"
            type="button"
            class="link"
            :data-test="`comment-delete-${comment.id}`"
            @click="remove(comment.id)"
          >
            删除
          </button>
        </div>
        <p v-if="comment.deletedAt" class="body tombstone" data-test="comment-tombstone">
          该评论已删除
        </p>
        <p v-else class="body">{{ comment.body }}</p>
      </li>
      <li v-if="!loading && comments.length === 0" class="empty">还没有评论。</li>
    </ul>

    <form ref="composeEl" class="compose" @submit.prevent="submit">
      <div v-if="quote" class="quote" data-test="comment-quote">
        <span class="quote-text">{{ quote }}</span>
        <button type="button" class="link" aria-label="移除引用" @click="dismissQuote">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
      <textarea
        ref="inputEl"
        v-model="body"
        rows="3"
        placeholder="就这份文档说点什么…"
        aria-label="评论内容"
        data-test="comment-input"
      />
      <UButton type="submit" size="sm" class="submit" :disabled="body.trim() === ''" data-test="comment-submit">
        发表
      </UButton>
    </form>
  </aside>
</template>

<style scoped>
.comments {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--unself-color-surface);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  overflow: hidden;
}

header {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  padding: var(--unself-space-3) var(--unself-space-4);
  border-bottom: 1px solid var(--unself-color-border);
  background: var(--unself-color-bg);
}
h3 {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  font-weight: 600;
}
.count {
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
}

.error {
  margin: 0;
  padding: var(--unself-space-2) var(--unself-space-4);
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-danger);
  background: var(--unself-color-danger-soft);
}

.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: var(--unself-space-3) var(--unself-space-4);
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
}

.meta {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
}
.author {
  color: var(--unself-color-text);
  font-weight: 500;
}
.body {
  margin: var(--unself-space-1) 0 0;
  font-size: var(--unself-font-size-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.tombstone {
  color: var(--unself-color-text-tertiary);
  font-style: italic;
}

.quote {
  display: flex;
  align-items: flex-start;
  gap: var(--unself-space-2);
  background: var(--unself-color-bg);
  border-left: 3px solid var(--unself-color-primary);
  border-radius: var(--unself-radius-sm);
  padding: var(--unself-space-2) var(--unself-space-3);
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-secondary);
  animation: quote-pop var(--unself-duration-normal) var(--unself-ease-out);
}
@keyframes quote-pop {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.quote-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.empty {
  color: var(--unself-color-text-tertiary);
  font-size: var(--unself-font-size-sm);
}

.link {
  display: inline-flex;
  align-items: center;
  margin-left: auto;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--unself-color-text-tertiary);
  cursor: pointer;
}
.link:hover {
  color: var(--unself-color-danger);
}

.compose {
  border-top: 1px solid var(--unself-color-border);
  padding: var(--unself-space-3) var(--unself-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
}

textarea {
  font: inherit;
  font-size: var(--unself-font-size-sm);
  resize: vertical;
  padding: var(--unself-space-2);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-surface);
  color: var(--unself-color-text);
}
textarea:focus-visible {
  outline: none;
  box-shadow: var(--unself-focus-ring);
}

.submit {
  align-self: flex-end;
}
</style>
