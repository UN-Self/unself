// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 文档预览渲染：markdown-it + DOMPurify 两段消毒（照 chat/lib/markdown.ts 的既有做法）。
 *
 * 与聊天消息的差别（有意为之）：
 * - breaks:false —— 文档里单个换行就是换行，不该变 <br>（Markdown 通行口径）；
 * - 白名单放开表格/代码块/hr（文档要用），仍然禁 img/iframe/script；
 * - 输出仅供 v-html 使用，组件禁止绕过本模块直接渲染用户输入。
 */
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

/** 文档面白名单：排版 + 表格 + 代码。禁 img/iframe（MVP 不做附件）。 */
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
  'hr',
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

const ALLOWED_ATTR = ['class', 'href', 'rel', 'target'] as const

/** 只放行 http(s) 绝对地址；javascript:/data: 一律拒绝。 */
export function isSafeWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({
    breaks: false,
    html: false, // 正文不接受内嵌 HTML（原始标签转义成可见文本）
    linkify: true,
    typographer: false,
  })
  md.validateLink = isSafeWebUrl
  return md
}

const renderer = createRenderer()

/** 渲染 Markdown → 已消毒 HTML（v-html 唯一出口）。 */
export function renderMarkdown(source: string): string {
  // 第一段（入口消毒）：script/style/iframe 连内容剥除、事件属性剥除。
  const pre = DOMPurify.sanitize(source)
  const raw = renderer.render(pre)
  // 第二段（出口白名单）：只留排版/表格/代码。
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
  })
}

/** 预览用的纯文本摘要（列表页/冲突对话框可用）：去标签、压空白、截断。 */
export function plainSummary(source: string, limit = 80): string {
  const text = renderMarkdown(source)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
