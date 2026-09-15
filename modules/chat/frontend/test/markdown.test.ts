// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { renderMarkdown } from '../src/lib/markdown'

/**
 * 消息 Markdown 消毒渲染行为（#218 C 路）：
 * 粗体/链接/换行兼容上游渲染；script/onerror 等 XSS 载荷必须剥离；
 * 裸 @username 高亮为 data-mention span，email 等非边界不误标；html:false 下原始标签转义显示。
 * 两问检验：去掉消毒/改坏 mention 边界 → 红；重构渲染实现行为不变 → 绿。
 */
describe('renderMarkdown', () => {
  it('粗体渲染为 strong，链接保留 href，单个换行折行（breaks）', () => {
    const html = renderMarkdown('**hi** and https://example.com')
    expect(html).toContain('<strong>hi</strong>')
    expect(html).toContain('href="https://example.com"')
    expect(renderMarkdown('a\nb')).toContain('<br')
  })

  it('剥离 script/style/iframe 标签与 onerror 事件属性（XSS 消毒）', () => {
    // script 连内容整体剥除（DOMPurify FORBID_CONTENTS 语义）；不可能以任何形态残留
    const scripted = renderMarkdown('<script>alert(1)<\/script>')
    expect(scripted).not.toContain('<script')
    expect(scripted).not.toContain('alert')

    const withHandler = renderMarkdown('x <img src=y onerror=alert(1)>')
    // 事件属性作为文本残留无害（不可执行）；断言的是「无活 img 标签」
    expect(withHandler).not.toContain('<img')
    expect(withHandler).toContain('&lt;img')

    const framed = renderMarkdown('<iframe src="//evil.example"></iframe>')
    expect(framed).not.toContain('<iframe')

    const styled = renderMarkdown('<style>*{display:none}</style>')
    expect(styled).not.toContain('<style')
  })

  it('裸 @username 渲染为 data-mention span；句首/句中/句尾均可', () => {
    expect(renderMarkdown('@bob hi')).toContain('<span data-mention="bob">@bob</span>')
    expect(renderMarkdown('say @bob!')).toContain('<span data-mention="bob">@bob</span>')
    expect(renderMarkdown('hey @bob')).toContain('<span data-mention="bob">@bob</span>')
  })

  it('非边界不误标：email 地址、更长用户名前缀、代码内文本', () => {
    expect(renderMarkdown('mail bob@example.com now')).not.toContain('data-mention')
    expect(renderMarkdown('hi @bob2 there')).not.toContain('data-mention="bob"')
    // 行内代码里的 @ 不高亮（markdown 语法包裹优先）
    expect(renderMarkdown('`@bob`')).not.toContain('data-mention')
  })

  it('html:false：原始 HTML 标签转义为可见文本而非渲染', () => {
    const html = renderMarkdown('a <b>bold</b> tag')
    expect(html).not.toMatch(/<b>/)
    expect(html).toContain('&lt;b&gt;')
  })
})
