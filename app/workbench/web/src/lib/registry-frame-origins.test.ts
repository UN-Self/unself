// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchFrameOrigins } from './registry-api'

/** fetchFrameOrigins（#247 外壳动态 CSP 数据源）：白名单 JSON → string[]；错误按 api-client 口径抛 ApiError。 */
describe('fetchFrameOrigins（决策 #63/#73：注册表白名单端点）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GET /api/modules/frame-origins → 返回 origin 数组', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('/api/modules/frame-origins')
      return new Response(JSON.stringify(['https://todo.example.org']), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchFrameOrigins()).resolves.toEqual(['https://todo.example.org'])
  })

  it('非 2xx → 抛 ApiError（人话文案走 messagePolicy）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })),
    )
    await expect(fetchFrameOrigins()).rejects.toMatchObject({ status: 500 })
  })
})
