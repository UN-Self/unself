// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { landingDefault, landingFromNext, resolveLanding, sanitizeNext } from './landing'

describe('sanitizeNext（防开放重定向）', () => {
  it('只接受本站绝对路径', () => {
    expect(sanitizeNext('/m/hello/')).toBe('/m/hello/')
    expect(sanitizeNext('/')).toBe('/')
  })

  it('拒绝外站、协议相对、非法形态', () => {
    expect(sanitizeNext('https://evil.example')).toBeNull()
    expect(sanitizeNext('//evil.example')).toBeNull()
    expect(sanitizeNext('m/hello')).toBeNull()
    expect(sanitizeNext('')).toBeNull()
    expect(sanitizeNext(null)).toBeNull()
  })
})

describe('登录落地规则（#11）', () => {
  it('来自模块跳转：回该模块', () => {
    expect(landingFromNext('/m/hello/')?.path).toBe('/m/hello/')
  })

  it('直访：落第一个启用模块', () => {
    expect(landingDefault(['hello', 'docs']).path).toBe('/m/hello/')
  })

  it('直访且全部停用：落工作台空态', () => {
    expect(landingDefault([]).path).toBe('/')
  })

  it('next 非法时回退默认落地', () => {
    expect(resolveLanding('https://evil.example', ['hello']).path).toBe('/m/hello/')
    expect(resolveLanding(undefined, []).path).toBe('/')
    expect(resolveLanding('/m/docs/', ['hello']).path).toBe('/m/docs/')
  })
})
