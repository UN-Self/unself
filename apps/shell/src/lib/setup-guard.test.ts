// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { decideSetupAccess } from './setup-guard'

describe('setup 路由守卫（#10）', () => {
  it('未激活 + 无令牌：放行（页面提示需要激活链接）', () => {
    expect(decideSetupAccess({ setupDone: false, hasToken: false, authenticated: false })).toBe('allow')
  })

  it('未激活 + 有令牌：放行向导（无论登录态，登录在激活时整页跳转）', () => {
    expect(decideSetupAccess({ setupDone: false, hasToken: true, authenticated: false })).toBe('allow')
    expect(decideSetupAccess({ setupDone: false, hasToken: true, authenticated: true })).toBe('allow')
  })

  it('已激活 + 已登录：重定向工作台（本页不复存在）', () => {
    expect(decideSetupAccess({ setupDone: true, hasToken: true, authenticated: true })).toBe('redirect-workspace')
    expect(decideSetupAccess({ setupDone: true, hasToken: false, authenticated: true })).toBe('redirect-workspace')
  })

  it('已激活 + 未登录：重定向登录页', () => {
    expect(decideSetupAccess({ setupDone: true, hasToken: true, authenticated: false })).toBe('redirect-login')
    expect(decideSetupAccess({ setupDone: true, hasToken: false, authenticated: false })).toBe('redirect-login')
  })
})
