<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorState as CmEditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import ConflictDialog from './ConflictDialog.vue'
import type { DocsApi } from '../lib/docs-api'
import type { ConflictChoice } from '../lib/docs-editor-state'
import { renderMarkdown } from '../lib/docs-markdown'
import type { Doc } from '../lib/docs-types'
import { useDocsEditor } from '../lib/use-docs-editor'

/**
 * D9 编辑器：CodeMirror 6（只开 Markdown 模式）+ 只读预览 + 保存/冲突链路。
 * 逻辑全在 lib/（纯函数 + composable），本文件只负责挂载与转发事件。
 */
const props = defineProps<{
  doc: Doc
  api: DocsApi
}>()

const emit = defineEmits<{ quote: [text: string] }>()

const editor = useDocsEditor({ doc: props.doc, api: props.api })
const { state, editable, saveable, saving, conflictOpen, errorMessage, charCount, delta, dirty } = editor

const preview = ref(false)
const host = ref<HTMLDivElement | null>(null)
/** 当前选中的正文文本（空串 = 没选）；供「评论所选」用。 */
const selectedText = ref('')

const html = computed(() => renderMarkdown(state.value.draft.content))

const roleText = computed(() => {
  const map: Record<string, string> = { owner: '所有者', editor: '可编辑', viewer: '只读' }
  return map[state.value.base.role] ?? state.value.base.role
})

const statusText = computed(() => {
  if (saving.value) return '保存中…'
  if (conflictOpen.value) return '有冲突待处理'
  if (state.value.status === 'error') return '保存失败'
  if (dirty.value) return '未保存'
  return '已同步'
})

const statusTone = computed(() => {
  if (saving.value) return 'busy'
  if (conflictOpen.value || state.value.status === 'error') return 'bad'
  if (dirty.value) return 'warn'
  return 'ok'
})

const editableCompartment = new Compartment()
let view: EditorView | null = null

/** 编辑区的表现层：只用语义令牌，禁裸色值（docs/modules.md 的前端硬规矩）。 */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--unself-color-surface)',
    color: 'var(--unself-color-text)',
    fontSize: 'var(--unself-font-size-base)',
  },
  '&.cm-focused': { outline: 'none' },
  // 自绘选区必须显式上色（CM6 不走浏览器原生 ::selection）；失焦后仍显示，方便选完去点「评论所选」
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--unself-color-primary-soft)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--unself-color-primary)' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.7' },
  '.cm-content': { padding: 'var(--unself-space-4) 0', caretColor: 'var(--unself-color-primary)' },
  '.cm-gutters': {
    backgroundColor: 'var(--unself-color-bg)',
    color: 'var(--unself-color-text-tertiary)',
    border: 'none',
    paddingRight: 'var(--unself-space-2)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--unself-color-surface-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--unself-color-surface-active)' },
})

onMounted(() => {
  if (host.value === null) return
  view = new EditorView({
    parent: host.value,
    state: CmEditorState.create({
      doc: state.value.draft.content,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        theme,
        editableCompartment.of(EditorView.editable.of(editable.value)),
        // Ctrl/Cmd+S 走同一条保存链路，不另开旁路
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                void editor.save()
                return true
              },
            },
          ]),
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) editor.setContent(update.state.doc.toString())
          if (update.selectionSet || update.docChanged) syncSelection(update)
        }),
      ],
    }),
  })
})

// 外部改了草稿（重载服务端版本、切换文档）→ 同步进 CodeMirror，且不形成回环
watch(
  () => state.value.draft.content,
  (next) => {
    if (view === null) return
    const current = view.state.doc.toString()
    if (current === next) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: next } })
  },
)

// 角色变化（切 viewer）→ 直接锁编辑区
watch(editable, (next) => {
  view?.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(next)) })
})

// 换文档：重建状态并刷新编辑器内容
watch(
  () => props.doc,
  (next) => {
    editor.reset(next)
  },
)

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

function onChoose(choice: ConflictChoice): void {
  void editor.chooseConflict(choice)
}

function syncSelection(update: ViewUpdate): void {
  const range = update.state.selection.main
  selectedText.value = update.state.sliceDoc(range.from, range.to)
}

/** 把编辑器里选中的文字交给评论侧栏（D10 引用所选）。点击瞬间实时读选区，不依赖缓存值。 */
function quoteSelection(): void {
  const range = view?.state.selection.main
  const live = range === undefined ? '' : (view?.state.sliceDoc(range.from, range.to) ?? '')
  const text = (live !== '' ? live : selectedText.value).trim()
  if (text !== '') emit('quote', text)
}
</script>

<template>
  <section class="doc-editor">
    <header class="bar">
      <input
        class="title-input"
        type="text"
        placeholder="未命名文档"
        :value="state.draft.title"
        :readonly="!editable"
        aria-label="文档标题"
        @input="editor.setTitle(($event.target as HTMLInputElement).value)"
      />

      <span class="meta">v{{ state.base.version }} · {{ roleText }} · {{ charCount }} 字</span>

      <span class="status" :data-tone="statusTone" data-test="save-status">{{ statusText }}</span>

      <button
        type="button"
        class="ghost"
        data-test="comment-selection"
        :disabled="selectedText.trim() === ''"
        title="选中正文后可引用评论"
        @click="quoteSelection"
      >
        评论所选
      </button>

      <button type="button" class="ghost" data-test="toggle-preview" @click="preview = !preview">
        {{ preview ? '编辑' : '预览' }}
      </button>

      <button
        type="button"
        class="primary"
        data-test="save"
        :disabled="!saveable"
        @click="editor.save()"
      >
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </header>

    <p v-if="errorMessage" class="notice bad" role="alert" data-test="save-error">
      {{ errorMessage }}
    </p>
    <p v-else-if="!editable" class="notice" data-test="readonly-hint">
      你在这份文档里的角色是「只读」，可以查看但不能保存修改。
    </p>

    <div class="body">
      <div ref="host" v-show="!preview" class="cm-host" data-test="cm-host"></div>
      <!-- 安全：唯一来源 renderMarkdown（markdown-it html:false + DOMPurify 白名单） -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <article v-if="preview" class="preview" data-test="preview" v-html="html"></article>
    </div>

    <ConflictDialog
      :open="conflictOpen"
      :current="state.conflict"
      :local-chars="delta?.chars ?? 0"
      :char-delta="delta?.charDelta ?? 0"
      :title-changed="delta?.titleChanged ?? false"
      @choose="onChoose"
    />
  </section>
</template>

<style scoped>
.doc-editor {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--unself-color-surface);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  overflow: hidden;
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--unself-space-3);
  padding: var(--unself-space-3) var(--unself-space-4);
  border-bottom: 1px solid var(--unself-color-border);
  background: var(--unself-color-bg);
}

.title-input {
  flex: 1;
  min-width: 0;
  font-size: var(--unself-font-size-lg);
  font-weight: 600;
  color: var(--unself-color-text);
  background: transparent;
  border: none;
  padding: var(--unself-space-1) var(--unself-space-2);
  border-radius: var(--unself-radius-sm);
}
.title-input:focus-visible {
  outline: none;
  box-shadow: var(--unself-focus-ring);
}
.title-input::placeholder {
  color: var(--unself-color-text-tertiary);
}

.meta {
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
  white-space: nowrap;
}

.status {
  font-size: var(--unself-font-size-xs);
  padding: 2px var(--unself-space-2);
  border-radius: var(--unself-radius-full);
  background: var(--unself-color-surface-active);
  color: var(--unself-color-text-secondary);
  white-space: nowrap;
}
.status[data-tone='ok'] {
  background: var(--unself-color-primary-soft);
  color: var(--unself-color-primary);
}
.status[data-tone='warn'] {
  background: var(--unself-color-warning);
  color: var(--unself-color-surface);
}
.status[data-tone='bad'] {
  background: var(--unself-color-danger-soft);
  color: var(--unself-color-danger);
}
.status[data-tone='busy'] {
  background: var(--unself-color-info);
  color: var(--unself-color-surface);
}

button {
  font: inherit;
  cursor: pointer;
  border-radius: var(--unself-radius-md);
  padding: var(--unself-space-2) var(--unself-space-3);
  transition: background var(--unself-duration-fast) var(--unself-ease-out);
}
button:focus-visible {
  outline: none;
  box-shadow: var(--unself-focus-ring);
}

.primary {
  background: var(--unself-color-primary);
  color: var(--unself-color-surface);
  border: 1px solid var(--unself-color-primary);
}
.primary:hover:not(:disabled) {
  background: var(--unself-color-primary-hover);
}
.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.ghost {
  background: transparent;
  color: var(--unself-color-text-secondary);
  border: 1px solid var(--unself-color-border);
}
.ghost:hover {
  background: var(--unself-color-surface-hover);
}

.notice {
  margin: 0;
  padding: var(--unself-space-2) var(--unself-space-4);
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
  border-bottom: 1px solid var(--unself-color-border);
}
.notice.bad {
  color: var(--unself-color-danger);
  background: var(--unself-color-danger-soft);
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.cm-host {
  height: 100%;
}

.preview {
  padding: var(--unself-space-6);
  max-width: 46rem;
  margin: 0 auto;
  color: var(--unself-color-text);
  line-height: 1.75;
}
.preview :deep(h1),
.preview :deep(h2),
.preview :deep(h3) {
  line-height: 1.3;
  margin: var(--unself-space-5) 0 var(--unself-space-3);
}
.preview :deep(h1) {
  font-size: var(--unself-font-size-2xl);
}
.preview :deep(h2) {
  font-size: var(--unself-font-size-xl);
}
.preview :deep(code) {
  background: var(--unself-color-surface-active);
  border-radius: var(--unself-radius-sm);
  padding: 0 var(--unself-space-1);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.preview :deep(pre) {
  background: var(--unself-color-bg);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  padding: var(--unself-space-3);
  overflow: auto;
}
.preview :deep(pre code) {
  background: transparent;
  padding: 0;
}
.preview :deep(blockquote) {
  margin: var(--unself-space-3) 0;
  padding-left: var(--unself-space-3);
  border-left: 3px solid var(--unself-color-border);
  color: var(--unself-color-text-secondary);
}
.preview :deep(a) {
  color: var(--unself-color-primary);
}
.preview :deep(table) {
  border-collapse: collapse;
  width: 100%;
}
.preview :deep(th),
.preview :deep(td) {
  border: 1px solid var(--unself-color-border);
  padding: var(--unself-space-2);
  text-align: left;
}
</style>
