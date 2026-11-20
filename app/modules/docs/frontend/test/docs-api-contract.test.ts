// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 客户端 ↔ 契约对拍：不看实现，只看「发出去的请求」和「进来的响应怎么被解释」。
 * D5 真后端上线那天，这组用例就是接线的验收单——路径/方法/字段名/409 解析，
 * 错一处这里先红，而不是联调时才发现。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DocsApiError, createHttpDocsApi } from '../src/lib/docs-api'
import type { Doc } from '../src/lib/docs-types'

const DOC: Doc = {
  id: 'doc_1',
  title: '标题',
  content: '正文',
  ownerId: 'u_1',
  version: 3,
  createdAt: '2026-11-17T10:00:00.000Z',
  updatedAt: '2026-11-17T10:00:00.000Z',
  role: 'owner',
}

interface ResponseLike {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

interface FetchCall {
  url: string
  init?: RequestInit
}

let calls: FetchCall[] = []

/** 挂一个假 fetch；jsdom 不提供网络，所有响应走内存。 */
function stubFetch(handler: (url: string, init?: RequestInit) => ResponseLike): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init })
      return handler(url, init)
    }),
  )
}

function json(status: number, body: unknown): ResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /api/docs/:id', () => {
  it('路径正确，Bearer 头随 token 走', async () => {
    stubFetch(() => json(200, DOC))
    const api = createHttpDocsApi({ getToken: () => 'tok_1' })
    await api.getDoc('doc_1')

    const call = calls[0]!
    expect(call.url).toBe('/api/docs/doc_1')
    expect((call.init?.headers as Record<string, string>).authorization).toBe('Bearer tok_1')
    expect((call.init?.headers as Record<string, string>)['content-type']).toBe('application/json')
  })

  it('没有 token 就不带 authorization 头（壳握手没好也能开发）', async () => {
    stubFetch(() => json(200, DOC))
    const api = createHttpDocsApi({ getToken: () => null })
    await api.getDoc('doc_1')

    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  it('id 里的特殊字符要转义', async () => {
    stubFetch(() => json(200, DOC))
    const api = createHttpDocsApi({ getToken: () => null })
    await api.getDoc('a/b c?d')

    expect(calls[0]!.url).toBe('/api/docs/a%2Fb%20c%3Fd')
  })

  it('baseUrl 只做前缀拼接', async () => {
    stubFetch(() => json(200, DOC))
    const api = createHttpDocsApi({ baseUrl: '/proxy', getToken: () => null })
    await api.getDoc('doc_1')

    expect(calls[0]!.url).toBe('/proxy/api/docs/doc_1')
  })

  it('401 缺 token → 抛对应错误码', async () => {
    stubFetch(() => json(401, { error: 'missing_bearer_token' }))
    const api = createHttpDocsApi({ getToken: () => null })
    await expect(api.getDoc('doc_1')).rejects.toMatchObject({
      code: 'missing_bearer_token',
      status: 401,
    })
  })

  it('404 非成员/不存在 → not_found', async () => {
    stubFetch(() => json(404, { error: 'not_found' }))
    const api = createHttpDocsApi({ getToken: () => 't' })
    await expect(api.getDoc('nope')).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })
})

describe('PUT /api/docs/:id（保存）', () => {
  const REQUEST = { id: 'doc_1', title: '新标题', content: '新正文', baseVersion: 3 }

  it('PUT 方法 + 请求体字段名与契约一致', async () => {
    stubFetch(() => json(200, { ...DOC, title: '新标题', content: '新正文', version: 4 }))
    const api = createHttpDocsApi({ getToken: () => 'tok_1' })
    await api.saveDoc(REQUEST)

    const init = calls[0]!.init!
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({
      title: '新标题',
      content: '新正文',
      baseVersion: 3,
    })
  })

  it('200 → 正常返回新行', async () => {
    const saved = { ...DOC, title: '新标题', version: 4 }
    stubFetch(() => json(200, saved))
    const api = createHttpDocsApi({ getToken: () => 'tok_1' })
    const result = await api.saveDoc(REQUEST)

    expect(result).toEqual({ ok: true, doc: saved })
  })

  it('409 带 current → 作为正常返回交给状态机，不抛异常', async () => {
    const current = { ...DOC, content: '服务端内容', version: 9 }
    stubFetch(() => json(409, { error: 'version_conflict', current }))
    const api = createHttpDocsApi({ getToken: () => 'tok_1' })
    const result = await api.saveDoc(REQUEST)

    expect(result).toEqual({ ok: false, reason: 'conflict', current })
  })

  it('409 但 current 缺失 → 视为后端违约，抛错（不许静默丢冲突信息）', async () => {
    stubFetch(() => json(409, { error: 'version_conflict' }))
    const api = createHttpDocsApi({ getToken: () => 'tok_1' })
    await expect(api.saveDoc(REQUEST)).rejects.toMatchObject({
      code: 'version_conflict',
      status: 409,
    })
  })

  it('403 viewer 写入 → forbidden', async () => {
    stubFetch(() => json(403, { error: 'forbidden' }))
    const api = createHttpDocsApi({ getToken: () => 'tok_1' })
    await expect(api.saveDoc(REQUEST)).rejects.toBeInstanceOf(DocsApiError)
    await expect(api.saveDoc(REQUEST)).rejects.toMatchObject({ code: 'forbidden', status: 403 })
  })

  it('错误体不是 JSON → 兜底 unknown，不炸界面', async () => {
    stubFetch(() => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('bad gateway html')
      },
    }))
    const api = createHttpDocsApi({ getToken: () => 'tok_1' })
    await expect(api.saveDoc(REQUEST)).rejects.toMatchObject({ code: 'unknown', status: 502 })
  })
})
