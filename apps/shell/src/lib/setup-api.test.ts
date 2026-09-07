// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { testOidcConnection } from './setup-api'

describe('testOidcConnection（表单[测试连接]按钮的本地逻辑）', () => {
  it('坏 URL 就地报错，不发请求', async () => {
    const result = await testOidcConnection('不是URL')
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('格式不正确') })
  })

  it('非 http(s) 协议报错', async () => {
    const result = await testOidcConnection('ftp://idp.example.com')
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('https://') })
  })

  it('路径带命名前缀时拼子路径发现文档', async () => {
    const result = await testOidcConnection('https://idp.example.com/realms/team')
    expect(result).toEqual({ ok: false, reason: expect.any(String) })
  })
})
