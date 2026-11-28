// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 前端 → docs 模块的 HTTP 边界。
 *
 * 为什么单列一个文件、而且只暴露两个方法：
 * 编辑器组件不该知道 URL 长什么样。D5（REST 业务）落地前后，这一层是唯一要改的地方；
 * 组件只认 `DocsApi` 这个接口，所以「D5 还没写完」不阻塞任何界面工作。
 */
import type { Doc, DocErrorCode, SaveRequest, SaveResult } from './docs-types'

/** 服务端错误（非 2xx 且不是 409）。code 直接来自响应体 { error }。 */
export class DocsApiError extends Error {
  readonly code: DocErrorCode | string
  readonly status: number

  constructor(code: string, status: number) {
    super(`docs api ${status}: ${code}`)
    this.name = 'DocsApiError'
    this.code = code
    this.status = status
  }
}

export interface DocsApi {
  /** GET /api/docs/:id */
  getDoc(id: string): Promise<Doc>
  /** PUT /api/docs/:id —— 200 与 409 都是正常返回，不抛。 */
  saveDoc(request: SaveRequest): Promise<SaveResult>
}

export interface HttpDocsApiOptions {
  /** 模块挂在 /m/docs，core 已剥离前缀，所以默认空串（同源相对路径）。 */
  baseUrl?: string
  /** 从壳拿到的短时模块 token（aud=docs）。由 D7 的握手层注入，编辑器不管来源。 */
  getToken: () => string | null
}

function authHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null && token !== '') headers.authorization = `Bearer ${token}`
  return headers
}

/** 把响应体解析成 { error } —— 解析失败也不抛，交给调用方按未知错误处理。 */
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

export function createHttpDocsApi(options: HttpDocsApiOptions): DocsApi {
  const base = options.baseUrl ?? ''

  return {
    async getDoc(id: string): Promise<Doc> {
      const response = await fetch(`${base}/api/docs/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: authHeaders(options.getToken()),
      })
      if (!response.ok) throw new DocsApiError(await readErrorCode(response), response.status)
      return (await response.json()) as Doc
    },

    async saveDoc(request: SaveRequest): Promise<SaveResult> {
      const response = await fetch(`${base}/api/docs/${encodeURIComponent(request.id)}`, {
        method: 'PUT',
        headers: authHeaders(options.getToken()),
        body: JSON.stringify({
          title: request.title,
          content: request.content,
          baseVersion: request.baseVersion,
        }),
      })

      if (response.status === 409) {
        const body = (await response.json()) as { error?: unknown; current?: unknown }
        if (body.current === undefined) throw new DocsApiError('version_conflict', 409)
        return { ok: false, reason: 'conflict', current: body.current as Doc }
      }
      if (!response.ok) throw new DocsApiError(await readErrorCode(response), response.status)
      return { ok: true, doc: (await response.json()) as Doc }
    },
  }
}
