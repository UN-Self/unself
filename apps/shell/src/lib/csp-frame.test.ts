// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { applyRegistryFrameOrigins, frameSrcFromMeta, tightenFrameSrcInMeta } from './csp-frame'

/**
 * 外壳 CSP 动态收紧行为测试（决策 #63/#73，#247）：
 * 断言打在「meta 里的 frame-src 有没有变宽/变窄」——真实浏览器行为是
 * CSP meta 在文档解析后不可再放宽，这里测的是我们自己的重写函数与调用链。
 */

function docWith(csp: string): Document {
  const meta = document.createElement('meta')
  meta.setAttribute('name', 'unself-csp-frame')
  meta.setAttribute('content', csp)
  document.head.appendChild(meta)
  return document
}

function cleanup(): void {
  document.querySelector('meta[name="unself-csp-frame"]')?.remove()
}

const BASE_CSP = "default-src 'self'; frame-src 'self'; object-src 'none'"

describe('frameSrcFromMeta / tightenFrameSrcInMeta', () => {
  it('无 meta → null（不动文档）', () => {
    cleanup()
    expect(frameSrcFromMeta(document)).toBeNull()
    expect(tightenFrameSrcInMeta(document, ['https://mod.example.com'])).toBeNull()
  })

  it('把白名单并入 frame-src 并写回 meta', () => {
    cleanup()
    docWith(BASE_CSP)
    const next = tightenFrameSrcInMeta(document, ['https://mod.example.com'])
    expect(next).toContain("frame-src 'self' https://mod.example.com")
    expect(next).toContain("object-src 'none'")
    expect(document.querySelector('meta[name="unself-csp-frame"]')!.getAttribute('content')).toBe(next)
    cleanup()
  })

  it('重复白名单去重；非 origin 垃圾值被丢弃（宁可窄不可宽）', () => {
    cleanup()
    docWith("frame-src 'self' https://already.example.com")
    const next = tightenFrameSrcInMeta(document, [
      'https://already.example.com',
      'https://new.example.com',
      'javascript:alert(1)',
      'not a url',
    ])
    expect(next).toBe("frame-src 'self' https://already.example.com https://new.example.com")
    cleanup()
  })
})

describe('applyRegistryFrameOrigins（拉取 + 收紧；失败 fail-closed 不放宽）', () => {
  it('注册表返回 origin → meta 被收紧', async () => {
    cleanup()
    docWith(BASE_CSP)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(['https://mod.example.com']), { status: 200 })),
    )
    await applyRegistryFrameOrigins(document)
    expect(document.querySelector('meta[name="unself-csp-frame"]')!.getAttribute('content')).toContain(
      'https://mod.example.com',
    )
    vi.unstubAllGlobals()
    cleanup()
  })

  it('注册表拉取失败（HTTP 500 / 网络异常）→ meta 保持基线，绝不放宽', async () => {
    cleanup()
    docWith(BASE_CSP)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await applyRegistryFrameOrigins(document)
    expect(document.querySelector('meta[name="unself-csp-frame"]')!.getAttribute('content')).toBe(BASE_CSP)

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))
    await applyRegistryFrameOrigins(document)
    expect(document.querySelector('meta[name="unself-csp-frame"]')!.getAttribute('content')).toBe(BASE_CSP)
    vi.unstubAllGlobals()
    cleanup()
  })
})
