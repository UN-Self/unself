// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 响应式断点（#218 布局）：窄屏判定经 matchMedia 驱动（桌面双栏 / 窄屏单栏切换）。
 * 断点取值纪律（AGENTS.md / verify-tokens 规则四）：768 = tokens.css --unself-bp-md，
 * 字面量单点对齐 tokens.css（CSS 规范不允许 @media 用 var()，JS 侧同款约束——改断点两处同步）。
 */

/** 窄屏上界（含）：max-width: 768px，与 tokens.css --unself-bp-md: 768px 同值。 */
export const NARROW_MAX_PX = 768

/** 测试/Node 环境可替换的最小 matchMedia 面。 */
export interface MediaQueryLike {
  matches: boolean
  addEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void
  removeEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void
}

/** 响应式 matchMedia：无 window / matchMedia（jsdom、SSR）时恒 false 且不挂监听。 */
export function useMediaQuery(query: string): { matches: boolean; dispose: () => void } {
  let matches = false
  let mql: MediaQueryLike | null = null
  let listener: ((event: { matches: boolean }) => void) | null = null

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mql = window.matchMedia(query) as MediaQueryLike
    matches = mql.matches
    listener = (event) => {
      matches = event.matches
    }
    mql.addEventListener('change', listener)
  }

  return {
    get matches() {
      return matches
    },
    dispose: () => {
      if (mql !== null && listener !== null) {
        mql.removeEventListener('change', listener)
      }
    },
  }
}

/** 是否窄屏（≤768px）：布局单栏/双栏的唯一判定源。 */
export function isNarrowViewport(): boolean {
  return useMediaQuery(`(max-width: ${NARROW_MAX_PX}px)`).matches
}
