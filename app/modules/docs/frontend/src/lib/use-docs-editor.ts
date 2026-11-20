// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 把状态机接到 Vue 上：组件只跟这个 composable 打交道。
 * 所有异步（保存、409、错误）在这里收口，组件里不出现 await。
 */
import { computed, onBeforeUnmount, onMounted, shallowRef, type ComputedRef, type ShallowRef } from 'vue'

import { DocsApiError, type DocsApi } from './docs-api'
import {
  beginSave,
  canEdit,
  canSave,
  createEditorState,
  draftDelta,
  editDraft,
  isDirty,
  resolveConflict,
  applyConflict,
  applyError,
  applySaved,
  shouldWarnBeforeLeave,
  type ConflictChoice,
  type EditorState,
} from './docs-editor-state'
import { errorText, type Doc, type DocErrorCode, type SaveRequest } from './docs-types'

export interface UseDocsEditorOptions {
  doc: Doc
  api: DocsApi
}

export interface UseDocsEditor {
  state: ShallowRef<EditorState>
  dirty: ComputedRef<boolean>
  editable: ComputedRef<boolean>
  saveable: ComputedRef<boolean>
  saving: ComputedRef<boolean>
  conflictOpen: ComputedRef<boolean>
  errorMessage: ComputedRef<string | null>
  charCount: ComputedRef<number>
  /** 冲突时本地相对服务端的改动摘要。 */
  delta: ComputedRef<{ titleChanged: boolean; charDelta: number; chars: number } | null>
  setTitle: (value: string) => void
  setContent: (value: string) => void
  save: () => Promise<void>
  chooseConflict: (choice: ConflictChoice) => Promise<void>
  reset: (doc: Doc) => void
}

export function useDocsEditor(options: UseDocsEditorOptions): UseDocsEditor {
  const state = shallowRef<EditorState>(createEditorState(options.doc))

  const api = options.api

  async function send(request: SaveRequest): Promise<void> {
    try {
      const result = await api.saveDoc(request)
      state.value = result.ok
        ? applySaved(state.value, result.doc)
        : applyConflict(state.value, result.current)
    } catch (error) {
      const code = error instanceof DocsApiError ? (error.code as DocErrorCode) : ('unknown' as DocErrorCode)
      state.value = applyError(state.value, code)
    }
  }

  const dirty = computed(() => isDirty(state.value))
  const editable = computed(() => canEdit(state.value))
  const saveable = computed(() => canSave(state.value))
  const saving = computed(() => state.value.status === 'saving')
  const conflictOpen = computed(() => state.value.status === 'conflict' && state.value.conflict !== null)
  const errorMessage = computed(() => (state.value.error === null ? null : errorText(state.value.error)))
  const charCount = computed(() => state.value.draft.content.length)
  const delta = computed(() =>
    conflictOpen.value ? draftDelta(state.value.base, state.value.draft) : null,
  )

  function setTitle(value: string): void {
    state.value = editDraft(state.value, { title: value })
  }

  function setContent(value: string): void {
    state.value = editDraft(state.value, { content: value })
  }

  async function save(): Promise<void> {
    const began = beginSave(state.value)
    state.value = began.state
    if (began.request === null) return
    await send(began.request)
  }

  async function chooseConflict(choice: ConflictChoice): Promise<void> {
    const resolved = resolveConflict(state.value, choice)
    state.value = resolved.state
    if (resolved.request !== null) await send(resolved.request)
  }

  function reset(doc: Doc): void {
    state.value = createEditorState(doc)
  }

  // 关标签页/刷新时拦一下：有未保存内容就问一句
  function beforeUnload(event: BeforeUnloadEvent): void {
    if (!shouldWarnBeforeLeave(state.value)) return
    event.preventDefault()
    // 老浏览器要求给 returnValue 赋值才弹
    event.returnValue = ''
  }

  onMounted(() => window.addEventListener('beforeunload', beforeUnload))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))

  return {
    state,
    dirty,
    editable,
    saveable,
    saving,
    conflictOpen,
    errorMessage,
    charCount,
    delta,
    setTitle,
    setContent,
    save,
    chooseConflict,
    reset,
  }
}
