// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeModule } from './modules-install-api'

/**
 * U10（#349）客户端 DELETE 形状测试：不 mock 本模块，直接打 fetch 桩，
 * 锁三件事——请求 URL/方法、POST/PUT 类同族函数不受影响、404 人话报错沿 ApiError 抛出。
 * （ADD_MODULE_PATHS 对拍表只覆盖 POST/GET/PUT；DELETE 路径在这里与后端 modules.ts 对拍。）
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 构造最小 Response mock（request() 会读 headers / status / json）。 */
function jsonResponse(init: { ok: boolean; status: number; body: unknown }): () => Promise<Response> {
  return async () => ({
    ok: init.ok,
    status: init.status,
    headers: { get: () => null },
    json: async () => init.body,
  } as unknown as Response)
}

describe('removeModule（U10，#349）', () => {
  it('DELETE /api/admin/modules/:id（id 编码进路径），返回 {id, removed}', async () => {
    const fetchMock = vi.fn(jsonResponse({ ok: true, status: 200, body: { id: 'hello', removed: true } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await removeModule('hello')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/admin/modules/hello')
    expect(init.method).toBe('DELETE')
    expect(result).toEqual({ id: 'hello', removed: true })
  })

  it('404 → 人话 ApiError（幂等语义：未注册即 404，不伪造成功）', async () => {
    vi.stubGlobal('fetch', vi.fn(jsonResponse({ ok: false, status: 404, body: { error: 'module not found' } })))

    await expect(removeModule('ghost')).rejects.toMatchObject({ status: 404, message: '请求失败（404）' })
  })
})
