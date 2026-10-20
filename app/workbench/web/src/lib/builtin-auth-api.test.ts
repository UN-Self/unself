// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 内置开通客户端（#165）：一次性 setup token 随 URL 提交 + 403 门禁人话。
 * 只 stub 网络层，真实跑 pk1 客户端派生（与浏览器同路径）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBuiltinAdmin } from './builtin-auth-api'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => {
    throw new Error('测试中不应发起真实 fetch')
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(init: { ok: boolean; status: number; body: unknown }): Response {
  return {
    ok: init.ok,
    status: init.status,
    headers: { get: () => null },
    json: async () => init.body,
  } as unknown as Response
}

function callArgs(): [RequestInfo | URL, RequestInit?] {
  const call = fetchMock.mock.calls[0]
  if (!call) throw new Error('fetch 未被调用')
  return call as [RequestInfo | URL, RequestInit?]
}

describe('createBuiltinAdmin（POST /api/setup/builtin-admin，#165 带 token）', () => {
  it('token 进 query（encodeURIComponent）+ body 只含 username/salt/proof', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        status: 201,
        body: { ok: true, user: { id: 'u_1', name: 'boss', role: 'admin' } },
      }),
    )

    const result = await createBuiltinAdmin('tok+/=1', 'boss', 'password123')

    expect(result.user).toMatchObject({ role: 'admin', name: 'boss' })
    const [url, init] = callArgs()
    expect(String(url)).toBe('/api/setup/builtin-admin?token=tok%2B%2F%3D1')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' })
    // pk1（决策 35）：盐/证明客户端生成，形状与后端 BUILTIN_ADMIN_SCHEMA 一致
    const body = JSON.parse(init?.body as string) as { username: string; salt: string; proof: string }
    expect(body.username).toBe('boss')
    expect(body.salt).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(body.proof).toMatch(/^[A-Za-z0-9+/]{43}=$/)
  })

  it('403（token 门拒绝）→ 用户可见人话，不透传服务端英文文案', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, status: 403, body: { error: 'invalid or already-used setup token' } }),
    )

    await expect(createBuiltinAdmin('tok-1', 'boss', 'password123')).rejects.toMatchObject({
      status: 403,
      message: '初始化链接无效或已被使用，请向部署者要新的链接',
    })
  })

  it.each(['Setup has been closed (new wording).', undefined])('409 + setup_sealed：文案为 %s 时仍显示中文封箱提示', async (error) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, status: 409, body: { error, code: 'setup_sealed' } }),
    )

    await expect(createBuiltinAdmin('tok-1', 'boss', 'password123')).rejects.toMatchObject({
      status: 409,
      code: 'setup_sealed',
      message: '实例已完成配置，setup 页面已关闭',
    })
  })

  it.each([
    'setup already completed; sealed forever',
    '  \nsetup already completed; sealed forever  ',
    'setup already completed.',
  ])('旧实例无 code：兼容封箱文案 %s', async (error) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, status: 409, body: { error } }))

    await expect(createBuiltinAdmin('tok-1', 'boss', 'password123')).rejects.toMatchObject({
      status: 409,
      message: '实例已完成配置，setup 页面已关闭',
    })
  })

  it.each([undefined, 'username_taken'])('409（用户名占用，code=%s）→ 服务端中文人话原样透传', async (code) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, status: 409, body: { error: '该用户名已被占用', code } }),
    )

    await expect(createBuiltinAdmin('tok-1', 'boss', 'password123')).rejects.toMatchObject({
      status: 409,
      message: '该用户名已被占用',
    })
  })

  it('存在其他错误码时按错误码判断，不用旧文案推断封箱', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: false,
      status: 409,
      body: { code: 'another_conflict', error: 'setup already completed; sealed forever' },
    }))

    await expect(createBuiltinAdmin('tok-1', 'boss', 'password123')).rejects.toMatchObject({
      status: 409,
      message: 'setup already completed; sealed forever',
    })
  })

  it('非 409 响应即使携带 setup_sealed，也保留实际错误提示', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: false,
      status: 500,
      body: { code: 'setup_sealed', error: '请求处理失败' },
    }))

    await expect(createBuiltinAdmin('tok-1', 'boss', 'password123')).rejects.toMatchObject({
      status: 500,
      message: '请求处理失败',
    })
  })
})
