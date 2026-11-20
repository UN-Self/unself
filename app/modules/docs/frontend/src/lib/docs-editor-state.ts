// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 编辑器状态机（D9 的核心）：纯函数、零 IO、零框架依赖。
 *
 * 为什么单独抽出来：
 * - 「脏了没」「能不能保存」「409 之后选什么」是 D9 唯一的真逻辑，
 *   放在 .vue 里就只能靠浏览器点，放在这里能逐格断言（见 test/docs-editor-state.test.ts）；
 * - 组件退化成「把 state 画出来 + 把事件转发进来」，CodeMirror 换了也不影响逻辑。
 *
 * 一条硬规矩：base 只在**保存成功**或**用户主动重载**时才被替换。
 * 409 时绝不偷偷把 base 换成服务端最新行——那会让界面误以为已经同步，用户的稿子就没了。
 */
import type { Doc, DocDraft, DocErrorCode, SaveRequest } from './docs-types'
import { roleCanEdit } from './docs-types'

/** 编辑器状态。saving 与 dirty 可以同时为真（保存中又改了），此时 status 记 saving。 */
export type EditorStatus = 'idle' | 'dirty' | 'saving' | 'conflict' | 'error'

/** 409 之后用户的三种选择。 */
export type ConflictChoice = 'overwrite' | 'reload' | 'cancel'

export interface EditorState {
  /** 最后一次与服务端一致的内容（乐观锁基准）。 */
  base: Doc
  /** 本地正在编辑的内容。 */
  draft: DocDraft
  status: EditorStatus
  /** 409 时服务端最新行；只用来说明冲突，不参与 base 替换。 */
  conflict: Doc | null
  /** 上一次失败的错误码（成功后清空）。 */
  error: DocErrorCode | null
}

/** 文档行 → 草稿（只取用户可改的两字段）。 */
export function draftOf(doc: Doc): DocDraft {
  return { title: doc.title, content: doc.content }
}

export function createEditorState(doc: Doc): EditorState {
  return { base: doc, draft: draftOf(doc), status: 'idle', conflict: null, error: null }
}

/** 有没有未保存的改动。 */
export function isDirty(state: EditorState): boolean {
  return state.draft.title !== state.base.title || state.draft.content !== state.base.content
}

/** 当前角色能不能编辑（viewer 只读）。 */
export function canEdit(state: EditorState): boolean {
  return roleCanEdit(state.base.role)
}

/** 保存按钮是否可点：有权限 + 有改动 + 没在保存中。 */
export function canSave(state: EditorState): boolean {
  return canEdit(state) && state.status !== 'saving' && isDirty(state)
}

/** 改标题/正文。保存中也能改——保存响应回来会重新判定 dirty，不会吞掉这几个字。 */
export function editDraft(state: EditorState, patch: Partial<DocDraft>): EditorState {
  const next: EditorState = {
    ...state,
    draft: { ...state.draft, ...patch },
    // 上一轮的错误/冲突在用户重新动手后就过期了
    error: null,
    conflict: state.status === 'conflict' ? state.conflict : null,
  }
  if (next.status === 'saving') return next
  return { ...next, status: isDirty(next) ? 'dirty' : 'idle' }
}

/**
 * 开始保存：把当前草稿与 base 版本号打包成请求。
 * 不满足条件时返回 null（调用方据此不发请求，避免空 PUT 与重复提交）。
 */
export function beginSave(state: EditorState): { state: EditorState; request: SaveRequest | null } {
  if (!canSave(state)) return { state, request: null }
  const request: SaveRequest = {
    id: state.base.id,
    title: state.draft.title,
    content: state.draft.content,
    baseVersion: state.base.version,
  }
  return { state: { ...state, status: 'saving', error: null }, request }
}

/** 保存成功：base 换成服务端返回行；保存期间又改过的话仍然是 dirty。 */
export function applySaved(state: EditorState, doc: Doc): EditorState {
  const next: EditorState = { base: doc, draft: state.draft, status: 'idle', conflict: null, error: null }
  return { ...next, status: isDirty(next) ? 'dirty' : 'idle' }
}

/** 409：只记下服务端行，base 不动，草稿不动。 */
export function applyConflict(state: EditorState, current: Doc): EditorState {
  return { ...state, status: 'conflict', conflict: current, error: null }
}

/** 其他失败（403/404/401/网络）：草稿保留，给错误码，用户可重试。 */
export function applyError(state: EditorState, code: DocErrorCode): EditorState {
  return { ...state, status: 'error', error: code, conflict: null }
}

/**
 * 处理冲突三选一。
 * - overwrite：拿服务端最新版本号重发一次（内容用本地草稿）
 * - reload：丢掉本地改动，接受服务端（这条不可逆，界面必须二次确认）
 * - cancel：什么都不做，本地草稿原样留着，回到 dirty
 */
export function resolveConflict(
  state: EditorState,
  choice: ConflictChoice,
): { state: EditorState; request: SaveRequest | null } {
  const current = state.conflict
  if (current === null) return { state, request: null }

  if (choice === 'reload') {
    return {
      state: { base: current, draft: draftOf(current), status: 'idle', conflict: null, error: null },
      request: null,
    }
  }

  if (choice === 'overwrite') {
    const request: SaveRequest = {
      id: state.base.id,
      title: state.draft.title,
      content: state.draft.content,
      baseVersion: current.version,
    }
    return { state: { ...state, status: 'saving', conflict: null, error: null }, request }
  }

  // cancel：关掉对话框，本地内容一个字都不丢
  return { state: { ...state, status: isDirty(state) ? 'dirty' : 'idle', conflict: null }, request: null }
}

/** 离开页面前要不要拦一下。 */
export function shouldWarnBeforeLeave(state: EditorState): boolean {
  return state.status === 'saving' || isDirty(state)
}

/** 冲突对话框里的一句话说明：本地相对服务端改了些什么。 */
export interface DraftDelta {
  titleChanged: boolean
  /** 正数=多了字，负数=少了字。 */
  charDelta: number
  /** 本地草稿总字数。 */
  chars: number
}

export function draftDelta(base: DocDraft, draft: DocDraft): DraftDelta {
  return {
    titleChanged: draft.title !== base.title,
    charDelta: draft.content.length - base.content.length,
    chars: draft.content.length,
  }
}
