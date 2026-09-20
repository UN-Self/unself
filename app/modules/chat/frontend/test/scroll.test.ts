// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { nearBottom, nearTop, scrollToBottom } from '../src/lib/scroll'

/**
 * 滚动判定行为（#218）：喂假元素（plain object 断言不出的行为面用真 Object 行为——
 * 直接改 getter 数值），改坏判定（nearTop 用 >=）→ 测试红；重构实现 → 绿。
 */

/** 用 Object.defineProperty 做只读几何假元素：行为面与 scroll 事件回调里拿到的一致。 */
function fakeEl(geo: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  const el = {} as HTMLElement
  for (const [key, value] of Object.entries(geo)) {
    Object.defineProperty(el, key, { value })
  }
  return el
}

describe('nearTop / nearBottom（#218）', () => {
  it('贴顶（含阈值内）true，离顶远 false', () => {
    // 400 高 → 阈值 max(24, 100) = 100
    expect(nearTop(fakeEl({ scrollTop: 0, scrollHeight: 2000, clientHeight: 400 }))).toBe(true)
    expect(nearTop(fakeEl({ scrollTop: 99, scrollHeight: 2000, clientHeight: 400 }))).toBe(true)
    expect(nearTop(fakeEl({ scrollTop: 101, scrollHeight: 2000, clientHeight: 400 }))).toBe(false)
  })

  it('贴底（含阈值内）true，离底远 false', () => {
    // scrollHeight 2000, clientHeight 400 → 距底 = 1600 - scrollTop
    expect(nearBottom(fakeEl({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 }))).toBe(true)
    expect(nearBottom(fakeEl({ scrollTop: 1501, scrollHeight: 2000, clientHeight: 400 }))).toBe(true)
    expect(nearBottom(fakeEl({ scrollTop: 1499, scrollHeight: 2000, clientHeight: 400 }))).toBe(false)
  })

  it('内容不足一屏（无滚动空间）双 true：贴顶也贴底', () => {
    const el = fakeEl({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })
    expect(nearTop(el)).toBe(true)
    expect(nearBottom(el)).toBe(true)
  })

  it('滚动到底：scrollTop 写为 scrollHeight-clientHeight 位置', () => {
    const writes: number[] = []
    const el = {} as HTMLElement
    Object.defineProperty(el, 'scrollTop', {
      get: () => writes.at(-1) ?? 0,
      set: (v: number) => {
        writes.push(v)
      },
      configurable: true,
    })
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
    scrollToBottom(el)
    expect(writes).toEqual([2000])
  })
})
