// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import {
  BASE_CSP_DIRECTIVES,
  frameSrcFromMeta,
  installFramePolicy,
  installFrameSrcInMeta,
} from './csp-frame'

/**
 * 外壳 CSP frame-src 挂载前注入的行为测试（决策 #63/#73，#247；#247b 修订）：
 *
 * 实测机制（Chrome 140，有头 E2E）：meta CSP 与响应头 CSP 取交集，且文档解析后
 * meta 的 frame-src 不可放宽——「构建期 meta 写死 frame-src 'self' + 运行期收紧」
 * 对跨域 iframe 是死锁（首个跨域 frame 被拦且永不重试）。
 * 唯一正确顺序：**挂载前**注入最终 frame-src（'self' + 白名单；失败回落基线）。
 */

function docWith(csp: string): Document {
  cleanup()
  const meta = document.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', csp)
  document.head.appendChild(meta)
  return document
}

function cleanup(): void {
  document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove()
}

const BASE_META_CSP = BASE_CSP_DIRECTIVES.join('; ')

describe('BASE_CSP_DIRECTIVES（构建 meta 占位唯一来源）', () => {
  it('不含 frame-src（构建期写死 frame-src 会让跨域模块死锁——#247b 实测）', () => {
    expect(BASE_CSP_DIRECTIVES.some((d) => d.startsWith('frame-src'))).toBe(false)
  })

  it('保留其余防线（frame-ancestors / object-src / script-src）', () => {
    expect(BASE_CSP_DIRECTIVES).toContain("frame-ancestors 'self'")
    expect(BASE_CSP_DIRECTIVES).toContain("object-src 'none'")
    expect(BASE_CSP_DIRECTIVES).toContain("script-src 'self'")
  })
})

describe('installFrameSrcInMeta（最终 frame-src 注入）', () => {
  it('meta 无 frame-src → 注入 frame-src self + origins（去重）', () => {
    docWith(BASE_META_CSP)
    const next = installFrameSrcInMeta(document, [
      'https://todo.example.org',
      'https://todo.example.org',
      'https://app.example.org',
    ])
    expect(next).toBe(`${BASE_META_CSP};frame-src 'self' https://todo.example.org https://app.example.org`)
    expect(frameSrcFromMeta(document)).toBe(`frame-src 'self' https://todo.example.org https://app.example.org`)
    cleanup()
  })

  it('meta 已有 frame-src → 原位替换（绝不叠旧值）', () => {
    docWith(`${BASE_META_CSP}; frame-src 'self' https://stale.example.org`)
    installFrameSrcInMeta(document, ['https://fresh.example.org'])
    expect(frameSrcFromMeta(document)).toBe(`frame-src 'self' https://fresh.example.org`)
    cleanup()
  })

  it('非 origin 垃圾值被丢弃（宁可窄不可宽）', () => {
    docWith(BASE_META_CSP)
    const next = installFrameSrcInMeta(document, ['javascript:alert(1)', 'not a url', 'https://ok.example.org'])
    expect(next).toBe(`${BASE_META_CSP};frame-src 'self' https://ok.example.org`)
    cleanup()
  })

  it('白名单为空 → 注入 frame-src self（基线仍显式存在）', () => {
    docWith(BASE_META_CSP)
    const next = installFrameSrcInMeta(document, [])
    expect(next).toBe(`${BASE_META_CSP};frame-src 'self'`)
    cleanup()
  })
})

describe('installFramePolicy（挂载前注入主入口：fail-closed 语义）', () => {
  beforeEach(() => {
    docWith(BASE_META_CSP)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    cleanup()
  })

  it('白名单到达 → meta 注入 self + 白名单（挂载前完成）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(['https://todo.example.org']), { status: 200 })),
    )
    const content = await installFramePolicy(document)
    expect(content).toBe(`${BASE_META_CSP};frame-src 'self' https://todo.example.org`)
    expect(frameSrcFromMeta(document)).toBe(`frame-src 'self' https://todo.example.org`)
  })

  it('HTTP 500 / 网络异常 / 形状错 → 注入 frame-src self 基线（绝不放宽、绝不无 frame-src）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await installFramePolicy(document)
    expect(frameSrcFromMeta(document)).toBe(`frame-src 'self'`)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    await installFramePolicy(document)
    expect(frameSrcFromMeta(document)).toBe(`frame-src 'self'`)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"not":"array"}', { status: 200 })))
    await installFramePolicy(document)
    expect(frameSrcFromMeta(document)).toBe(`frame-src 'self'`)
  })

  it('非 origin 值被过滤：白名单只有垃圾值时仍回落 self 基线', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(['javascript:alert(1)']), { status: 200 })),
    )
    await installFramePolicy(document)
    expect(frameSrcFromMeta(document)).toBe(`frame-src 'self'`)
  })
})
