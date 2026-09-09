// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { HANDSHAKE_TIMEOUT_MS, isDisabledFrameError } from './use-module-frame'

describe('isDisabledFrameError（#83 停用判定唯一真值 = token 接口 403）', () => {
  it('status 403 为停用（ApiError 形态）', () => {
    expect(isDisabledFrameError(Object.assign(new Error('此模块已停用'), { status: 403 }))).toBe(
      true,
    )
  })

  it('非 403 状态不算停用（401/404/成功等）', () => {
    expect(isDisabledFrameError(Object.assign(new Error('登录已过期'), { status: 401 }))).toBe(
      false,
    )
    expect(isDisabledFrameError(Object.assign(new Error('未找到'), { status: 404 }))).toBe(false)
  })

  it('禁字符串嗅探：message 含「停用」但无 403 状态不判停用', () => {
    expect(isDisabledFrameError(new Error('此模块已停用'))).toBe(false)
  })

  it('非对象/缺状态回退 false', () => {
    expect(isDisabledFrameError(null)).toBe(false)
    expect(isDisabledFrameError(undefined)).toBe(false)
    expect(isDisabledFrameError('此模块已停用')).toBe(false)
  })

  it('超时常量仍是 15s（§6.5 契约）', () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBe(15_000)
  })
})
