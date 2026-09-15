// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest'

import { NARROW_MAX_PX, useMediaQuery } from '../src/lib/viewport'

/**
 * 响应式断点（#218 布局切换的行为面）：
 * - 断点常量必须与 tokens.css --unself-bp-md 同值（布局双栏/单栏契约，verify-tokens 之外的行为级守卫）。
 * - useMediaQuery 跟随 matches 翻转（布局随视口切换的机制），无 matchMedia 环境不抛。
 */

const listeners = new Map<(event: { matches: boolean }) => void, (event: { matches: boolean }) => void>()
let currentMatches = false

function fakeMatchMedia() {
  return {
    get matches() {
      return currentMatches
    },
    addEventListener(_type: string, listener: (event: { matches: boolean }) => void) {
      listeners.set(listener, listener)
    },
    removeEventListener(_type: string, listener: (event: { matches: boolean }) => void) {
      listeners.delete(listener)
    },
  }
}

afterEach(() => {
  // @ts-expect-error 测试夹具：还原 jsdom 环境
  delete window.matchMedia
  listeners.clear()
  currentMatches = false
})

describe('useMediaQuery（#218）', () => {
  it('初始 matches 跟随环境，翻转后读取到新值', () => {
    ;(window as { matchMedia?: unknown }).matchMedia = fakeMatchMedia
    currentMatches = true

    const mq = useMediaQuery(`(max-width: ${NARROW_MAX_PX}px)`)
    expect(mq.matches).toBe(true)

    currentMatches = false
    for (const notify of listeners.values()) notify({ matches: false })
    expect(mq.matches).toBe(false)

    mq.dispose()
  })

  it('无 matchMedia（极老环境）恒 false 且不抛', () => {
    delete (window as { matchMedia?: unknown }).matchMedia
    const { matches } = useMediaQuery('(max-width: 768px)')
    expect(matches).toBe(false)
  })
})
