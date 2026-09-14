// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeApiError,
  NETWORK_UNAVAILABLE,
  preferServerMessage,
  request,
  requestOk,
  send,
  statusOnlyMessage,
} from './api-client'

/** 默认 fetch 桩：任何未经 mock 的请求都视为失败（不允许真实网络）。 */
let baseFetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  baseFetchMock = vi.fn(async () => {
    throw new Error('测试中不应发起真实 fetch')
  })
  vi.stubGlobal('fetch', baseFetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 构造最小可用的 Response mock（request() 会读 headers / json）。 */
function jsonResponse(init: { ok: boolean; status: number; body?: unknown; requestId?: string | null }) {
  return {
    ok: init.ok,
    status: init.status,
    headers: { get: (name: string) => (name === 'x-request-id' ? (init.requestId ?? null) : null) },
    json: async () => init.body,
  } as unknown as Response
}

describe('request（统一出口：凭证/解析/错误形状）', () => {
  it('2xx 回解析后 JSON；默认带 same-origin 凭证', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, status: 200, body: { hello: 'world' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(request('/api/x')).resolves.toEqual({ hello: 'world' })
    expect(fetchMock).toHaveBeenCalledWith('/api/x', { credentials: 'same-origin' })
  })

  it('调用方 init 合并：凭证缺省 same-origin，显式方法/头/body 原样透传', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, status: 200, body: null }))
    vi.stubGlobal('fetch', fetchMock)

    await request('/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })
    expect(fetchMock).toHaveBeenCalledWith('/api/x', {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    })
  })

  it('非 2xx：message 优先取后端 error（trim 后非空），status 透传', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false, status: 410, body: { error: '  邀请链接已过期  ' } })),
    )

    await expect(request('/api/x')).rejects.toMatchObject({
      status: 410,
      message: '邀请链接已过期',
    })
  })

  it('非 2xx 且 body 非 JSON → 回 `请求失败（<status>）`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ ok: false, status: 500 }).valueOf(),
      ),
    )

    await expect(request('/api/x')).rejects.toMatchObject({ status: 500, message: '请求失败（500）' })
  })

  it('x-request-id → err.requestId；body.detail → err.detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: false,
          status: 409,
          body: { detail: '邮箱前缀已被占用' },
          requestId: 'req-7',
        }),
      ),
    )

    const err = await request('/api/x').catch((e) => e)
    expect(err).toMatchObject({ status: 409, requestId: 'req-7', detail: '邮箱前缀已被占用' })
  })

  it('网络异常 → status 0 + 网络不可用人话', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await expect(request('/api/x')).rejects.toMatchObject({ status: 0, message: NETWORK_UNAVAILABLE })
  })

  it('自定义 messagePolicy 生效（status-only 域）：文案由策略决定', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false, status: 502, body: { error: '忽略我' } })),
    )

    await expect(
      request('/api/x', undefined, { messagePolicy: statusOnlyMessage }),
    ).rejects.toMatchObject({ status: 502, message: '请求失败（502）' })
  })

  it('2xx 但 body 非 JSON → 解析为 null（不抛）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ ok: true, status: 200 }).valueOf(),
      ),
    )

    await expect(request('/api/x')).resolves.toBeNull()
  })
})

describe('send（无 body 解析路径：POST 动作类）', () => {
  it('2xx 不解析 body，resolve undefined', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, status: 200, body: { ok: true } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(send('/api/x', { method: 'POST' })).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/x', { credentials: 'same-origin', method: 'POST' })
  })

  it('非 2xx 抛 ApiError（error 字段优先）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false, status: 409, body: { error: '该成员无内置登录' } })),
    )

    await expect(send('/api/x', { method: 'POST' })).rejects.toMatchObject({
      status: 409,
      message: '该成员无内置登录',
    })
  })

  it('网络异常抛 status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await expect(send('/api/x')).rejects.toMatchObject({ status: 0 })
  })
})

describe('requestOk（探测：只看 2xx，不解析不抛）', () => {
  it('2xx → true；4xx/5xx → false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, status: 200, body: null })))
    await expect(requestOk('/api/me')).resolves.toBe(true)

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, status: 401, body: null })))
    await expect(requestOk('/api/me')).resolves.toBe(false)
  })

  it('网络异常 → false（探测语义，不抛）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await expect(requestOk('/api/me')).resolves.toBe(false)
  })
})

describe('错误形状公共件', () => {
  it('makeApiError：status/message/requestId/detail 齐全', () => {
    const err = makeApiError(500, '请求失败（500）', 'req-1', 'detail-text')
    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject({ status: 500, message: '请求失败（500）', requestId: 'req-1', detail: 'detail-text' })
  })

  it('preferServerMessage：后端 error trim 优先，空值回请求失败', () => {
    expect(preferServerMessage(500, '  后端人话  ')).toBe('后端人话')
    expect(preferServerMessage(500, '   ')).toBe('请求失败（500）')
    expect(preferServerMessage(500)).toBe('请求失败（500）')
  })

  it('statusOnlyMessage：忽略后端 error', () => {
    expect(statusOnlyMessage(418, 'x')).toBe('请求失败（418）')
  })
})
