// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 通道 A（§6.5.5）主题直注：壳在模块 iframe 加载后直接向 contentDocument
 * 注入 <style id="unself-tokens">——手写页（不引 SDK）也自动有值。
 * 仅同源模块可用（contentDocument 可访问）；跨域第三方模块返回 null，走通道 B（SDK 握手）。
 */
import { tokenCssName, type ThemeTokens } from '@unself/contracts'

/** 注入的 style 元素 id：通道 A 的唯一锚点（幂等判定、SDK 与体检共用）。 */
export const FRAME_TOKENS_STYLE_ID = 'unself-tokens'

/**
 * 主题包 → <style> 文本内容。以 ':root {' 开头，按语义名排序逐行输出
 * `  --unself-...: value;`（排序保证输出稳定），尾部 '}' 闭合。
 */
export function tokensStyleSource(tokens: ThemeTokens): string {
  const lines = Object.keys(tokens)
    .sort()
    .map((key) => `  ${tokenCssName(key)}: ${tokens[key]};`)
  return `:root {\n${lines.join('\n')}\n}`
}

/**
 * 给模块 iframe 挂通道 A 注入：iframe 加载（load 事件）后向 contentDocument
 * 注入 style#unself-tokens（幂等：已存在即跳过，重复 load 不累积）。
 * 挂载时点晚于 iframe 加载（readyState complete）则立即注入。
 * contentDocument 不可访问（跨域第三方模块）或为 null → 返回 null（走通道 B），不抛。
 */
export function attachFrameTokens(
  iframe: HTMLIFrameElement,
  tokens: ThemeTokens,
): { detach: () => void } | null {
  let doc: Document | null
  try {
    doc = iframe.contentDocument
  } catch {
    return null
  }
  if (doc === null) return null

  function inject(): void {
    // 重读 contentDocument：挂接后 iframe 可能已导航/跨域（此时静默放弃）
    let current: Document | null
    try {
      current = iframe.contentDocument
    } catch {
      return
    }
    if (current === null || current.getElementById(FRAME_TOKENS_STYLE_ID)) return
    const style = current.createElement('style')
    style.id = FRAME_TOKENS_STYLE_ID
    style.textContent = tokensStyleSource(tokens)
    ;(current.head ?? current.documentElement).appendChild(style)
  }

  if (doc.readyState === 'complete') inject()

  const onLoad = () => inject()
  iframe.addEventListener('load', onLoad)

  return {
    detach: () => {
      iframe.removeEventListener('load', onLoad)
    },
  }
}
