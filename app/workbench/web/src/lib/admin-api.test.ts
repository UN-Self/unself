// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 管理台 API 客户端请求形状测试（#340 三段设置域 + 两个候选测试端点）。
 * 页面测试把本模块整体 vi.mock 掉了，URL 拼错 / 漏信封（{ oidc } 外壳）在前端与后端两侧都不会红——
 * 「测试绿≠生产活」。这里锁的正是那一层：真实 fetch 桩 + 断言 URL、方法、信封与字段。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  fetchSettings,
  saveOidcSettings,
  saveSmtpSettings,
  saveStalwartSettings,
  testSmtpConnection,
  testStalwartConnection,
} from './admin-api'

/** 默认 fetch 桩：未经 mock 的请求一律视为失败（测试中不允许真实网络）。 */
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

/** 构造最小可用的 Response mock（request() 会读 headers / status / json）。 */
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

const INSTANCE_SETTINGS = {
  oidc: { issuer: 'https://idp.example.com', clientId: 'c1', clientSecret: '***', scope: 'openid' },
  stalwart: { enabled: true, baseUrl: 'https://mail.example.com', apiKey: '***', domain: 'example.com', portalUrl: '' },
  smtp: { enabled: false, host: 'smtp.example.com', port: 465, username: 'u', password: '***', from: 'noreply@example.com' },
}

describe('设置域读（GET /api/admin/settings）', () => {
  it('GET 三段形状原样返回（密钥已是 ***：客户端不做二次脱敏）', async () => {
    const fetchMock = mockFetchOnce(jsonResponse({ ok: true, status: 200, body: INSTANCE_SETTINGS }))

    const settings = await fetchSettings()

    expect(settings).toEqual(INSTANCE_SETTINGS)
    const [url, init] = callArgs(fetchMock)
    expect(String(url)).toBe('/api/admin/settings')
    expect(init?.method ?? 'GET').toBe('GET')
  })
})

describe('设置域写（三条独立 PUT，各只碰本段）', () => {
  it('saveOidcSettings → PUT /api/admin/settings，body 带 { oidc } 外壳', async () => {
    const fetchMock = mockFetchOnce(jsonResponse({ ok: true, status: 200, body: { ok: true } }))

    await saveOidcSettings({ issuer: 'https://idp.example.com', clientSecret: 's3cret' })

    const [url, init] = callArgs(fetchMock)
    expect(String(url)).toBe('/api/admin/settings')
    expect(init?.method).toBe('PUT')
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' })
    // 信封是硬契约：后端只认 { oidc }，直发字段会被 zod strip 静默忽略（保存变空操作）
    expect(JSON.parse(init?.body as string)).toEqual({
      oidc: { issuer: 'https://idp.example.com', clientSecret: 's3cret' },
    })
  })

  it('saveStalwartSettings → PUT /api/admin/settings/mail-stalwart，body 是扁平段（无外层信封）', async () => {
    const fetchMock = mockFetchOnce(jsonResponse({ ok: true, status: 200, body: { ok: true } }))

    await saveStalwartSettings({ enabled: false, baseUrl: 'https://mail.example.com', apiKey: 'k1' })

    const [url, init] = callArgs(fetchMock)
    expect(String(url)).toBe('/api/admin/settings/mail-stalwart')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({
      enabled: false,
      baseUrl: 'https://mail.example.com',
      apiKey: 'k1',
    })
  })

  it('saveSmtpSettings → PUT /api/admin/settings/mail-smtp，body 是扁平段（port 保持数字）', async () => {
    const fetchMock = mockFetchOnce(jsonResponse({ ok: true, status: 200, body: { ok: true } }))

    await saveSmtpSettings({ enabled: true, host: 'smtp.example.com', port: 465 })

    const [url, init] = callArgs(fetchMock)
    expect(String(url)).toBe('/api/admin/settings/mail-smtp')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({
      enabled: true,
      host: 'smtp.example.com',
      port: 465,
    })
  })
})

describe('候选草稿测试端点（两个独立 POST，草稿不落库）', () => {
  it('testStalwartConnection → POST /api/admin/mail-stalwart/test，body 是草稿扁平字段', async () => {
    const fetchMock = mockFetchOnce(
      jsonResponse({ ok: true, status: 200, body: { ok: true, detail: '已连接，域名 example.com 可用' } }),
    )

    const result = await testStalwartConnection({
      baseUrl: 'https://mail.example.com',
      apiKey: '',
      domain: 'example.com',
    })

    expect(result).toEqual({ ok: true, detail: '已连接，域名 example.com 可用' })
    const [url, init] = callArgs(fetchMock)
    expect(String(url)).toBe('/api/admin/mail-stalwart/test')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      baseUrl: 'https://mail.example.com',
      apiKey: '',
      domain: 'example.com',
    })
  })

  it('testSmtpConnection → POST /api/admin/mail-smtp/test，port 以草稿字符串原样发出', async () => {
    const fetchMock = mockFetchOnce(
      // HTTP 200 + 业务 ok:false：候选草稿缺字段是正常答复，不是传输层失败
      jsonResponse({ ok: true, status: 200, body: { ok: false, detail: '请先填写完整的 SMTP 配置' } }),
    )

    const result = await testSmtpConnection({
      host: 'smtp.example.com',
      port: '465',
      username: 'u',
      password: '',
      from: 'noreply@example.com',
    })

    // 缺字段也是 200 + ok:false 人话（绝不 500）
    expect(result).toEqual({ ok: false, detail: '请先填写完整的 SMTP 配置' })
    const [url, init] = callArgs(fetchMock)
    expect(String(url)).toBe('/api/admin/mail-smtp/test')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      host: 'smtp.example.com',
      port: '465',
      username: 'u',
      password: '',
      from: 'noreply@example.com',
    })
  })
})