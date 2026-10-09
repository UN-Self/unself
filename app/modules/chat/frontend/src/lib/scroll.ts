// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 消息流滚动判定（#218 历史分页 + 自动贴底）：
 * 纯函数吃容器元素，组件层只在 scroll 事件里调用——行为测试直接喂假元素即可。
 */

/** 默认阈值：距边 1 屏（可视高 25%）内算「贴近」。 */
function defaultThresholdPx(el: HTMLElement): number {
  return Math.max(24, Math.round(el.clientHeight * 0.25))
}

/** 贴近顶部 → 触发「上翻加载更早历史」的时机。 */
export function nearTop(el: HTMLElement, thresholdPx?: number): boolean {
  return el.scrollTop <= (thresholdPx ?? defaultThresholdPx(el))
}

/** 贴近底部 → 新消息自动滚底 / 「回到底部」按钮显隐的时机。 */
export function nearBottom(el: HTMLElement, thresholdPx?: number): boolean {
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  return distance <= (thresholdPx ?? defaultThresholdPx(el))
}

/** 定位到容器中的垂直位置；smooth 交由浏览器执行。 */
export function scrollToPosition(
  el: HTMLElement,
  top: number,
  behavior: ScrollBehavior = 'auto',
): void {
  // 原生 scrollTo 的 smooth 行为由浏览器执行；jsdom/旧 WebView 没有该方法时回退到 setter。
  try {
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top, behavior })
      return
    }
    el.scrollTop = top
  } catch {
    // 只读保护环境（测试假元素冻结等）：滚动是尽力而为的展示增强。
  }
}

/** 滚动到底部；新消息/按钮可以选择 smooth，首次定位默认立即到位。 */
export function scrollToBottom(el: HTMLElement, behavior: ScrollBehavior = 'auto'): void {
  try {
    scrollToPosition(el, el.scrollHeight, behavior)
  } catch {
    // 只读保护环境（测试假元素冻结等）：静默——滚动是尽力而为的展示增强。
  }
}
