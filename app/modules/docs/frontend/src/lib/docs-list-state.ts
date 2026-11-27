// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 文档列表状态机（D8）：纯函数、零 IO、零框架依赖。
 *
 * 为什么单列：列表页唯一会出错的地方不是画界面，而是「什么时候显示空态 / 加载 / 错误」
 * 与「删除后本地怎么收敛」。放在 .vue 里只能靠点击验证，放这里能逐格断言。
 *
 * 一条硬规矩：删除只在**服务端确认成功**后才从本地移除；失败时条目原样留在列表，
 * 并把错误码交给界面——不能先乐观移除再回滚，那会让用户以为已经删掉。
 *
 * 分页口径与后端仓储对齐（PR #366 repo/documents.ts）：offset/limit，不是游标。
 * 契约正文写的是 `?cursor=`，但已落地的仓储是 `ListDocumentsOptions{limit, offset}`；
 * 这里按 offset 走，等契约正文与实现收口时两边一起改（记录见 PR 描述）。
 */
import type { Doc } from './docs-types'

export type ListStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * 错误码：已知码走 DocErrorCode，服务端可能回未登记的新码（DocsApiError.code 也是宽类型），
 * 所以这里存 string，翻译由 errorText() 兜底——未知码给通用文案，不吞错。
 */
export type ListErrorCode = string

export interface ListState {
  items: Doc[]
  /** 是否还有下一页（后端按 offset 分页，不返回游标）。 */
  hasMore: boolean
  /** 下一页的 offset（= 已加载条数）。 */
  nextOffset: number
  /** 首屏加载状态；翻页时不动它（避免整页闪空）。 */
  status: ListStatus
  /** 错误码：加载失败、删除失败都在这里，成功后清空。 */
  error: ListErrorCode | null
  /** 正在删除的文档 id 集合（按钮转圈用）。 */
  deleting: readonly string[]
}

/** 单页上限（#358 §6：单页 ≤50）。 */
export const PAGE_LIMIT = 50

export function createListState(): ListState {
  return { items: [], hasMore: false, nextOffset: 0, status: 'idle', error: null, deleting: [] }
}

/** 开始加载首屏。 */
export function beginLoad(state: ListState): ListState {
  return { ...state, status: 'loading', error: null }
}

/** 手头有数据时的刷新：保留条目、不切骨架（列表页「返回后刷新」用）。 */
export function beginRefresh(state: ListState): ListState {
  return state.items.length === 0 ? { ...state, status: 'loading', error: null } : { ...state, error: null }
}

/** 一页结果：条目 + 是否还有下一页（后端 limit+1 探测或返回条数满页）。 */
export interface PageResult {
  items: Doc[]
  hasMore: boolean
}

/** 首屏加载成功：整表替换，分页位置重置。 */
export function applyLoaded(state: ListState, page: PageResult): ListState {
  return {
    ...state,
    items: page.items,
    hasMore: page.hasMore,
    nextOffset: page.items.length,
    status: 'ready',
    error: null,
  }
}

/** 翻页追加：去重（同一 id 以新值为准），分页位置推进。 */
export function applyAppended(state: ListState, page: PageResult): ListState {
  const byId = new Map(state.items.map((doc) => [doc.id, doc]))
  for (const doc of page.items) byId.set(doc.id, doc)
  const items = [...byId.values()]
  return {
    ...state,
    items,
    hasMore: page.hasMore,
    nextOffset: items.length,
    status: 'ready',
    error: null,
  }
}

/** 加载失败：首屏失败进 error 态，翻页失败保留已有条目。 */
export function applyLoadFailed(state: ListState, code: ListErrorCode): ListState {
  const isFirstPage = state.items.length === 0
  return { ...state, status: isFirstPage ? 'error' : 'ready', error: code }
}

/** 新建成功：新文档排在最前（列表按 updated_at DESC，新文档最新）。 */
export function applyCreated(state: ListState, doc: Doc): ListState {
  return { ...state, items: [doc, ...state.items.filter((item) => item.id !== doc.id)] }
}

/** 标记某条正在删除（按钮禁用/转圈）。 */
export function beginDelete(state: ListState, id: string): ListState {
  if (state.deleting.includes(id)) return state
  return { ...state, deleting: [...state.deleting, id], error: null }
}

/** 删除成功：从列表移除。 */
export function applyDeleted(state: ListState, id: string): ListState {
  return {
    ...state,
    items: state.items.filter((doc) => doc.id !== id),
    deleting: state.deleting.filter((value) => value !== id),
  }
}

/** 删除失败：条目原样保留，只清标记并报错。 */
export function applyDeleteFailed(state: ListState, id: string, code: ListErrorCode): ListState {
  return {
    ...state,
    deleting: state.deleting.filter((value) => value !== id),
    error: code,
  }
}

/** 还能不能继续翻页。 */
export function canLoadMore(state: ListState): boolean {
  return state.hasMore && state.status !== 'loading'
}
