// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Markdown 消息渲染（#218）：markdown-it + DOMPurify 两段消毒。
 * 行为规格（test/markdown.test.ts）：粗体/链接/换行兼容上游消息渲染；
 * script/style/iframe 连内容剥除、on* 事件属性剥除（XSS 基线）；
 * 裸 @username（边界对齐）高亮为 data-mention span；html:false 下原始标签转义为可见文本。
 * 输出供 v-html 使用——组件禁止绕过本模块直接渲染用户输入。
 */
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import type { Mention } from './types'

/** 消息面白名单：块级/行内排版标签；禁 img/iframe/script 等富载体。 */
const ALLOWED_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
] as const

const ALLOWED_ATTR = ['class', 'href', 'rel', 'target', 'data-mention', 'data-mention-user-id'] as const

/** http(s) 绝对地址才放行（javascript:/data: 一律拒绝）。 */
export function isSafeWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

/** mention 文本形状：@username（字母数字下划线连字符，可带点分层）。 */
const MENTION_RE = /@([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)/g

/**
 * mention 边界：起点前一个字符 / 终点处字符必须是空白/标点/符号或文本首尾——
 * 防止 email（bob@example.com）与更长用户名前缀（@bob2 ≠ @bob）误标。
 */
function isMentionBoundary(text: string, index: number, isEnd: boolean): boolean {
  const char = isEnd ? text[index] : index > 0 ? text[index - 1] : undefined
  return char === undefined || /[\s\p{P}\p{S}]/u.test(char)
}

function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({
    breaks: true,
    html: false, // 消息正文不接受内嵌 HTML（原始标签一律转义显示）
    linkify: true, // 裸 URL 自动成链（与上游渲染兼容）
    typographer: false,
  })
  md.validateLink = isSafeWebUrl
  return md
}

const renderer = createRenderer()

/** 在纯文本 token 里渲染裸 mention：`@username` → data-mention span（html:false 下字符串安全）。 */
function renderMentions(text: string): string {
  let out = ''
  let last = 0
  for (const match of text.matchAll(MENTION_RE)) {
    const start = match.index ?? 0
    if (!isMentionBoundary(text, start, false) || !isMentionBoundary(text, start + match[0].length, true)) {
      continue
    }
    const username = renderer.utils.escapeHtml(match[1] ?? '')
    out += renderer.utils.escapeHtml(text.slice(last, start))
    out += `<span data-mention="${username}">@${username}</span>`
    last = start + match[0].length
  }
  return out + renderer.utils.escapeHtml(text.slice(last))
}

/** text token 是纯文本输出点（code/链接等有各自规则，天然跳过 mention 污染）。 */
renderer.renderer.rules.text = (tokens, idx) => {
  const content = tokens[idx]?.content ?? ''
  return content.includes('@') ? renderMentions(content) : renderer.utils.escapeHtml(content)
}

/** 渲染消息 Markdown → 已消毒 HTML（v-html 唯一出口）。 */
export function renderMarkdown(source: string): string {
  // 第一段（入口消毒）：script/style/iframe 连内容剥除、事件属性剥除、危险协议剥除。
  const pre = DOMPurify.sanitize(source)
  const raw = renderer.render(pre)
  // 第二段（出口白名单）：只保留消息面排版/链接/mention 标记。
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    ALLOW_DATA_ATTR: true,
  })
}

/** @提及高亮（服务端已解析的 mentions）：把 @displayName/@username 文本包成带 data 的 span。 */
function highlightMentions(html: string, mentions: Mention[]): string {
  if (!mentions.length) return html
  const container = document.createElement('div')
  container.innerHTML = html
  const walk = (node: Node): void => {
    if (node.nodeType !== Node.TEXT_NODE) {
      for (const child of Array.from(node.childNodes)) walk(child)
      return
    }
    const text = node.textContent ?? ''
    let found: Mention | null = null
    let matched = ''
    for (const mention of mentions) {
      const byName = `@${mention.displayName}`
      const byUser = `@${mention.username}`
      if (text.includes(byName)) {
        found = mention
        matched = byName
        break
      }
      if (text.includes(byUser)) {
        found = mention
        matched = byUser
        break
      }
    }
    if (found === null) return
    const parts = text.split(matched)
    const fragment = document.createDocumentFragment()
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part) fragment.appendChild(document.createTextNode(part))
      if (i < parts.length - 1) {
        const span = document.createElement('span')
        span.className = 'chat-mention'
        span.dataset.mentionUserId = String(found.userId)
        span.textContent = matched
        fragment.appendChild(span)
      }
    }
    node.parentNode?.replaceChild(fragment, node)
  }
  walk(container)
  return container.innerHTML
}

export interface RenderMessageOptions {
  /** 已解析的 @提及（服务端 mentions 字段；用于高亮，不参与解析）。 */
  mentions?: Mention[]
}

/** 渲染消息正文（含服务端 mentions 高亮）→ 已消毒 HTML（v-html 专用出口）。 */
export function renderMessageHtml(content: string, options: RenderMessageOptions = {}): string {
  const html = renderMarkdown(content)
  return highlightMentions(html, options.mentions ?? [])
}
