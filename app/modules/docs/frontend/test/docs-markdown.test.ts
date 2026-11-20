// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 预览渲染的安全基线（照 chat/test/markdown 的口径）：XSS 面逐条钉死。
 * 这些用例红了不要改断言——先看是不是把消毒层拆了。
 */
import { describe, expect, it } from 'vitest'

import { isSafeWebUrl, plainSummary, renderMarkdown } from '../src/lib/docs-markdown'

describe('Markdown 基本渲染', () => {
  it('标题/粗体/代码正常出标签', () => {
    const html = renderMarkdown('# 标题\n\n**粗** `code`')
    expect(html).toContain('<h1>')
    expect(html).toContain('<strong>')
    expect(html).toContain('<code>')
  })

  it('表格保留（文档要用，聊天不用）', () => {
    const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>')
  })

  it('围栏代码块保留', () => {
    expect(renderMarkdown('```ts\nconst a = 1\n```')).toContain('<pre>')
  })

  it('单换行不变成 <br>（文档口径，与聊天相反）', () => {
    expect(renderMarkdown('第一行\n第二行')).not.toContain('<br>')
  })
})

describe('消毒', () => {
  it('script 连内容一起剥掉', () => {
    const html = renderMarkdown('正文<script>alert(1)</script>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('iframe 不留', () => {
    expect(renderMarkdown('<iframe src="https://x.test"></iframe>')).not.toContain('<iframe')
  })

  it('onerror 之类事件属性剥掉', () => {
    const html = renderMarkdown('<span onmouseover="alert(1)">x</span>')
    expect(html).not.toContain('onmouseover')
  })

  it('javascript: 链接不生成 <a>（降级成纯文本，不是可点链接）', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))')
    expect(html).not.toContain('<a')
  })

  it('https 链接正常成链', () => {
    expect(renderMarkdown('[点我](https://example.com)')).toContain('href="https://example.com"')
  })

  it('data: 图片协议也进不来', () => {
    expect(renderMarkdown('![x](data:image/svg+xml,<svg onload=alert(1)>)')).not.toContain('<img')
  })

  it('原始 HTML 标签转义成可见文本', () => {
    expect(renderMarkdown('<b>粗</b>')).toContain('&lt;b&gt;')
  })
})

describe('链接白名单', () => {
  it.each([
    ['https://example.com', true],
    ['http://example.com/a', true],
    ['javascript:alert(1)', false],
    ['data:text/html,x', false],
    ['/relative/path', false],
  ])('%s → %s', (url, expected) => {
    expect(isSafeWebUrl(url)).toBe(expected)
  })
})

describe('摘要', () => {
  it('去标签、压空白、超长截断', () => {
    expect(plainSummary('# 标题\n\n**粗**')).toBe('标题 粗')
    expect(plainSummary('a'.repeat(20), 5)).toBe('aaaaa…')
  })
})
