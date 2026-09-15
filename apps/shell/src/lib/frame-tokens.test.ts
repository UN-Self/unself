// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_THEME,
} from '@unself/contracts'

import { attachFrameTokens, FRAME_TOKENS_STYLE_ID, tokensStyleSource } from './frame-tokens'

describe('tokensStyleSource（通道 A 注入的 style 文本，§6.5.5）', () => {
  /** 从 style 文本解析出的「声明名 → 值」映射（jsdom 不解析 var() 计算，改验声明本身落地）。 */
  function declaredMap(source: string): Map<string, string> {
    const map = new Map<string, string>()
    for (const m of source.matchAll(/\s*(--unself-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      map.set(m[1]!, m[2]!.trim())
    }
    return map
  }

  /** 契约独立来源：tokens.css :root 块（壳自身消费的同一份真值，非被测函数输出）。 */
  async function shellTokensCss(): Promise<Map<string, string>> {
    // jsdom 的 import.meta.url 是 http(s) 方案，readFile 只收 file:// ——vitest cwd = apps/shell
    const css = await readFile(pathToFileURL(join(process.cwd(), 'src/tokens.css')), 'utf8')
    const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/)![1]!
    const map = new Map<string, string>()
    for (const m of rootBlock.matchAll(/(--unself-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      map.set(m[1]!, m[2]!.trim())
    }
    return map
  }

  /** 平台内部令牌（动效/焦点环）：tokens.css 声明但不在契约包内（通道注入只投契约令牌，
   *  scripts/verify-tokens.mjs 规则二口径）。交叉校验只比对两处都有的键。 */
  const PLATFORM_ONLY = new Set(['--unself-duration-fast', '--unself-duration-normal', '--unself-ease-out', '--unself-focus-ring'])

  it('默认包注入文本与壳 tokens.css 逐项同值（同一契约两处实现不漂移）', async () => {
    // 交叉校验（非自证）：被测对象 = tokensStyleSource(DEFAULT_THEME) 的产出；
    // 对照真值 = apps/shell/src/tokens.css 的 :root 声明（壳自身启动依赖的独立来源）。
    // DEFAULT_THEME 若与壳实际注入的值漂移（改名/改值漏同步），这里必红。
    const declared = declaredMap(tokensStyleSource(DEFAULT_THEME))
    const shell = await shellTokensCss()
    expect(declared.size).toBeGreaterThan(0)
    for (const [name, value] of shell) {
      if (PLATFORM_ONLY.has(name)) continue
      expect(declared.get(name), `${name} 在通道 A 注入文本中缺失或值漂移`).toBe(value)
    }
  })

  it('声明名全部 --unself- 前缀、无重复键、行形状合法（:root 块 + 分号结尾）', () => {
    const src = tokensStyleSource(DEFAULT_THEME)
    expect(src.startsWith(':root {')).toBe(true)
    expect(src.trimEnd().endsWith('}')).toBe(true)
    const lines = src.split('\n').slice(1, -1)
    for (const line of lines) {
      expect(line).toMatch(/^  --unself-[a-z0-9-]+: .+;$/)
    }
    const names = lines.map((l) => /^  (--unself-[a-z0-9-]+):/.exec(l)![1]!)
    expect(new Set(names).size).toBe(names.length) // 无重复键
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
      `--unself-color-primary: ${DEFAULT_THEME['unself.color.primary']};`,
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
