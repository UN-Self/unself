// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_THEME,
  THEME_TOKEN_CSS_NAMES,
  THEME_TOKEN_KEYS,
  tokenCssName,
} from '@unself/contracts'

import { attachFrameTokens, FRAME_TOKENS_STYLE_ID, tokensStyleSource } from './frame-tokens'

describe('tokensStyleSource（通道 A 注入的 style 文本，§6.5.5）', () => {
  it('以 :root { 开头、} 结尾，包含全部契约令牌的 CSS 名与对应值', () => {
    const src = tokensStyleSource(DEFAULT_THEME)
    expect(src.startsWith(':root {')).toBe(true)
    expect(src.trimEnd().endsWith('}')).toBe(true)
    for (const key of THEME_TOKEN_KEYS) {
      expect(src).toContain(`${tokenCssName(key)}: ${DEFAULT_THEME[key]};`)
    }
    for (const cssName of THEME_TOKEN_CSS_NAMES) {
      expect(src).toContain(cssName)
    }
  })

  it('每行是合法 CSS 声明：两空格缩进、以分号结尾、行数 = 契约全量', () => {
    const body = tokensStyleSource(DEFAULT_THEME).split('\n').slice(1, -1)
    expect(body).toHaveLength(THEME_TOKEN_KEYS.length)
    for (const line of body) {
      expect(line).toMatch(/^  --[a-z0-9-]+: .+;$/)
    }
  })

  it('输出稳定：同一 tokens 两次调用产出相同字符串（按键名排序）', () => {
    const first = tokensStyleSource(DEFAULT_THEME)
    const second = tokensStyleSource(DEFAULT_THEME)
    expect(second).toBe(first)
  })
})

describe('attachFrameTokens（same-origin 直注，§6.5.5 通道 A）', () => {
  function mountIframe(): HTMLIFrameElement {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    return iframe
  }

  it('load 事件后注入 style#unself-tokens，内容含令牌值（手写页自动有值）', () => {
    const iframe = mountIframe()
    const handle = attachFrameTokens(iframe, DEFAULT_THEME)
    expect(handle).not.toBeNull()

    iframe.dispatchEvent(new Event('load'))
    const style = iframe.contentDocument!.getElementById(FRAME_TOKENS_STYLE_ID)
    expect(style).not.toBeNull()
    expect(style!.textContent).toContain(
      `${tokenCssName('unself.color.primary')}: ${DEFAULT_THEME['unself.color.primary']};`,
    )
    iframe.remove()
    handle!.detach()
  })

  it('重复触发 load 幂等：始终只有一个 style#unself-tokens', () => {
    const iframe = mountIframe()
    const handle = attachFrameTokens(iframe, DEFAULT_THEME)
    iframe.dispatchEvent(new Event('load'))
    iframe.dispatchEvent(new Event('load'))
    iframe.dispatchEvent(new Event('load'))
    expect(iframe.contentDocument!.querySelectorAll(`#${FRAME_TOKENS_STYLE_ID}`)).toHaveLength(1)
    iframe.remove()
    handle!.detach()
  })

  it('detach 后不再注入：删除已有 style 再触发 load 不复活', () => {
    const iframe = mountIframe()
    const handle = attachFrameTokens(iframe, DEFAULT_THEME)!
    iframe.dispatchEvent(new Event('load'))
    const doc = iframe.contentDocument!
    doc.getElementById(FRAME_TOKENS_STYLE_ID)!.remove()
    handle.detach()
    iframe.dispatchEvent(new Event('load'))
    expect(doc.getElementById(FRAME_TOKENS_STYLE_ID)).toBeNull()
    iframe.remove()
  })

  it('contentDocument 不可访问（跨域 getter 抛 SecurityError）→ 返回 null 且不抛', () => {
    const iframe = document.createElement('iframe')
    Object.defineProperty(iframe, 'contentDocument', {
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
    expect(() => attachFrameTokens(iframe, DEFAULT_THEME)).not.toThrow()
    expect(attachFrameTokens(iframe, DEFAULT_THEME)).toBeNull()
  })

  it('contentDocument 为 null → 返回 null（走通道 B）', () => {
    const iframe = document.createElement('iframe')
    Object.defineProperty(iframe, 'contentDocument', { get: () => null })
    expect(attachFrameTokens(iframe, DEFAULT_THEME)).toBeNull()
  })
})
