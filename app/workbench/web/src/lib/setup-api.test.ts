// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { activateSetup, saveOidcConfig, testOidcConnection } from './setup-api'

/** 默认 fetch 桩：测试中任何未经 mock 的请求都视为失败（不允许真实网络）。 */
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
function jsonResponse(init: { ok: boolean; status: number; body: unknown }): () => Promise<Response> {
  return async () => ({
    ok: init.ok,
    status: init.status,
    headers: { get: () => null },
    json: async () => init.body,
  } as unknown as Response)
}

function mockFetchOnce(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** 取首次调用的参数（calls[0] 可能为 undefined，noUncheckedIndexedAccess）。 */
function callArgs(fetchMock: ReturnType<typeof vi.fn>): [RequestInfo | URL, RequestInit?] {
  const call = fetchMock.mock.calls[0]
  if (!call) throw new Error('fetch 未被调用')
  return call as [RequestInfo | URL, RequestInit?]
}

describe('saveOidcConfig（POST /api/setup/oidc-config）', () => {
  it('POST JSON body 严格三字段 + content-type，成功解析 loginUrl', async () => {
    const fetchMock = mockFetchOnce(
      jsonResponse({
        ok: true,
        status: 200,
        body: {
          ok: true,
          loginUrl: 'https://idp.example.com/api/auth/login?next=%2Fsetup%3Ftoken%3Dtok-1',
        },
      }),
    )

    const result = await saveOidcConfig('tok-1', {
      issuer: 'https://idp.example.com',
      clientId: 'c1',
      clientSecret: 's3cret',
      scope: 'openid profile email',
    })

    expect(result).toEqual({
      ok: true,
      loginUrl: 'https://idp.example.com/api/auth/login?next=%2Fsetup%3Ftoken%3Dtok-1',
    })
    const [url, init] = callArgs(fetchMock)
    expect(String(url)).toBe('/api/setup/oidc-config?token=tok-1')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' })
    // 契约：三字段必填、无 scope 字段（即使调用方传入 scope 也不发）
    expect(JSON.parse(init?.body as string)).toEqual({
      issuer: 'https://idp.example.com',
      clientId: 'c1',
      clientSecret: 's3cret',
    })
  })

  it('token 经 encodeURIComponent 进 query', async () => {
    const fetchMock = mockFetchOnce(
      jsonResponse({ ok: true, status: 200, body: { ok: true, loginUrl: '/api/auth/login' } }),
    )

    await saveOidcConfig('tok 1/x', { issuer: 'https://idp.example.com', clientId: 'c1', clientSecret: 's' })

    const [url] = callArgs(fetchMock)
    expect(String(url)).toBe('/api/setup/oidc-config?token=tok%201%2Fx')
  })

  it('非 200 抛 ApiError（人话 + 状态码）', async () => {
    mockFetchOnce(jsonResponse({ ok: false, status: 403, body: { error: 'invalid or already-used setup token' } }))

    await expect(
      saveOidcConfig('tok-1', { issuer: 'https://idp.example.com', clientId: 'c1', clientSecret: 's' }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining('无效或已被使用') })
  })
})

describe('activateSetup（POST /api/setup/activate）', () => {
  it('POST 无 body，token 进 query，成功返回首个管理员', async () => {
    const fetchMock = mockFetchOnce(
      jsonResponse({
        ok: true,
        status: 200,
        body: { ok: true, user: { id: 'u1', name: '管理员', role: 'admin' } },
      }),
    )

    const result = await activateSetup('tok-1')

    expect(result).toEqual({ ok: true, user: { id: 'u1', name: '管理员', role: 'admin' } })
    const [url, init] = callArgs(fetchMock)
    expect(String(url)).toBe('/api/setup/activate?token=tok-1')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeUndefined()
  })
})

describe('testOidcConnection（表单[测试连接]按钮的本地预检 + 服务端代理）', () => {
  it('坏 URL 就地报错，不发请求', async () => {
    const result = await testOidcConnection('不是URL')
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('格式不正确') })
    expect(baseFetchMock).not.toHaveBeenCalled()
  })

  it('非 https 协议就地报错，不发请求', async () => {
    const result = await testOidcConnection('ftp://idp.example.com')
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('https://') })
    expect(baseFetchMock).not.toHaveBeenCalled()

    const httpResult = await testOidcConnection('http://idp.example.com')
    expect(httpResult).toEqual({ ok: false, reason: expect.stringContaining('https://') })
    expect(baseFetchMock).not.toHaveBeenCalled()
  })

  it('走服务端代理端点（非浏览器直连），成功返回 ok + issuer', async () => {
    const fetchMock = mockFetchOnce(
      jsonResponse({
        ok: true,
        status: 200,
        body: {
          ok: true,
          issuer: 'https://idp.example.com',
          authorization_endpoint: 'https://idp.example.com/authorize',
          token_endpoint: 'https://idp.example.com/token',
        },
      }),
    )

    const result = await testOidcConnection('https://idp.example.com/realms/team')
    expect(result).toEqual({ ok: true, issuer: 'https://idp.example.com', warnings: [] })
    const [url, init] = callArgs(fetchMock)
    expect(url).toBe('/api/oidc/test-connection')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({ issuer: 'https://idp.example.com/realms/team' })
  })

  it('成功响应的 warnings 原样透传（#17 设置页黄牌）', async () => {
    mockFetchOnce(
      jsonResponse({
        ok: true,
        status: 200,
        body: {
          ok: true,
          issuer: 'https://idp.example.com',
          warnings: ['该 IdP 可能无法完成登录（不回显 nonce）'],
        },
      }),
    )

    const result = await testOidcConnection('https://idp.example.com')
    expect(result).toEqual({
      ok: true,
      issuer: 'https://idp.example.com',
      warnings: ['该 IdP 可能无法完成登录（不回显 nonce）'],
    })
  })

  it('400 映射为 https 人话', async () => {
    mockFetchOnce(jsonResponse({ ok: false, status: 400, body: { ok: false, error: 'issuer must be https' } }))

    const result = await testOidcConnection('https://idp.example.com')
    expect(result).toEqual({ ok: false, reason: 'Issuer 地址需要以 https:// 开头' })
  })

  it('502 映射为网络可达人话', async () => {
    mockFetchOnce(jsonResponse({ ok: false, status: 502, body: { ok: false, error: 'fetch failed' } }))

    const result = await testOidcConnection('https://idp.example.com')
    expect(result).toEqual({ ok: false, reason: '无法访问该 Issuer：请检查地址是否正确或网络可达性' })
  })

  it('网络异常提示服务端侧不可达', async () => {
    mockFetchOnce(async () => {
      throw new TypeError('Network request failed')
    })

    const result = await testOidcConnection('https://idp.example.com')
    expect(result).toEqual({ ok: false, reason: '连接测试失败：请确认服务端可访问该 Issuer' })
  })
})
