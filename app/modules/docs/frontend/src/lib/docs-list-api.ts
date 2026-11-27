// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 文档列表 API（D8）：列表、新建、删除三件事的 HTTP 边界。
 *
 * 与 docs-api.ts 的关系：那个文件服务编辑器（getDoc / saveDoc），本文件服务列表页。
 * 拆开是为了让两边的消费者互不牵制——列表页不需要知道编辑器的 409 语义，反之亦然。
 *
 * 分页口径（见 docs-list-state.ts 头注释）：后端仓储是 offset/limit，不是游标。
 * 后端多取一条来判断 hasMore，前端不猜「满页就是还有」——最后恰好 50 条时不会多一次空请求。
 */
import { DocsApiError } from './docs-api'
import type { Doc, DocRole } from './docs-types'

/** 列表页最简的 API 面。 */
export interface DocsListApi {
  /** GET /api/docs?limit=&offset= */
  listDocs(options?: { limit?: number; offset?: number }): Promise<{ items: Doc[]; hasMore: boolean }>
  /** POST /api/docs */
  createDoc(input?: { title?: string; content?: string }): Promise<Doc>
  /** DELETE /api/docs/:id —— 成功返回 void。 */
  deleteDoc(id: string): Promise<void>
}

export interface HttpDocsListApiOptions {
  /** 接口地址前缀，默认 `'.'`（相对当前页面）；不能写 `/api/...`，理由见 docs-api.ts。 */
  baseUrl?: string
  /** 从壳拿到的短时模块 token（aud=docs）。 */
  getToken: () => string | null
}

/** 单页上限（#358 §6：单页 ≤50）。 */
const MAX_PAGE = 50

function authHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null && token !== '') headers.authorization = `Bearer ${token}`
  return headers
}

/** 解析 { error }；解析失败不抛，交给调用方按未知错误处理。 */
async function readErrorCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const code = (body as { error: unknown }).error
      if (typeof code === 'string') return code
    }
  } catch {
    // 非 JSON 响应：落到兜底码
  }
  return 'unknown'
}

/** 列表项：后端可能只回文档行，role 由端点决定；缺省按 viewer 处理（宁严不松）。 */
function toListDoc(raw: unknown): Doc {
  const doc = raw as Doc
  const role: DocRole = doc.role ?? 'viewer'
  return { ...doc, role }
}

export function createHttpDocsListApi(options: HttpDocsListApiOptions): DocsListApi {
  const base = options.baseUrl ?? '.'

  return {
    async listDocs(query = {}) {
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? MAX_PAGE), 1), MAX_PAGE)
      const offset = Math.max(Math.trunc(query.offset ?? 0), 0)
      const response = await fetch(`${base}/api/docs?limit=${limit}&offset=${offset}`, {
        headers: authHeaders(options.getToken()),
      })
      if (!response.ok) throw new DocsApiError(await readErrorCode(response), response.status)

      const body = (await response.json()) as { items?: unknown; hasMore?: unknown }
      const items = Array.isArray(body.items) ? body.items.map(toListDoc) : []
      // 后端不回 hasMore 时按「满页 = 可能还有」兜底，宁可多发一次请求也不漏条目
      const hasMore = typeof body.hasMore === 'boolean' ? body.hasMore : items.length === limit
      return { items, hasMore }
    },

    async createDoc(input = {}) {
      const response = await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: authHeaders(options.getToken()),
        body: JSON.stringify({
          title: input.title ?? '未命名文档',
          content: input.content ?? '',
        }),
      })
      if (!response.ok) throw new DocsApiError(await readErrorCode(response), response.status)
      return toListDoc(await response.json())
    },

    async deleteDoc(id: string) {
      const response = await fetch(`${base}/api/docs/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: authHeaders(options.getToken()),
      })
      if (!response.ok) throw new DocsApiError(await readErrorCode(response), response.status)
    },
  }
}
