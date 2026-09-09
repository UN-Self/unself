// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { humanizeLoginError, LOGIN_ERROR_TITLE } from './login-error'

describe('humanizeLoginError（#60 T4 短错误码 → 人话）', () => {
  it('core-api 四枚举各有专属人话', () => {
    expect(humanizeLoginError('oidc_state_mismatch')?.message).toContain('state')
    expect(humanizeLoginError('oidc_token_expired')?.message).toContain('过期')
    expect(humanizeLoginError('oidc_provider_error')?.message).toContain('身份源')
    expect(humanizeLoginError('oidc_failed')?.message).toContain('管理员')
  })

  it('标题固定为「登录暂时不可用」', () => {
    expect(humanizeLoginError('oidc_failed')?.title).toBe(LOGIN_ERROR_TITLE)
  })

  it('无 error 参数：不显示异常卡', () => {
    expect(humanizeLoginError(undefined)).toBeNull()
    expect(humanizeLoginError(null)).toBeNull()
    expect(humanizeLoginError('')).toBeNull()
  })

  it('未知/非字符串错误码：回退通用人话，不暴露原始值', () => {
    const fallback = humanizeLoginError('boom_raw_detail')
    expect(fallback).not.toBeNull()
    expect(fallback?.message).not.toContain('boom_raw_detail')
    expect(humanizeLoginError(['oidc_failed'])).toBeNull()
  })
})
