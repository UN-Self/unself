// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #230/#347 提及文本共享口径：词边界判定 + 文本切分（渲染 @ 高亮用）。
 * Composer 的回填与 MessageContent 的气泡高亮共用同一实现，避免两处边界口径漂移；
 * 与 worker/src/data/mentions.js 的 isMentionBoundary 语义对齐（服务端按 content 复核提及）。
 */

/** 提及词边界：行首/行尾算边界，`@` 前与提及名后需落在空白或标点（含中文标点、半角冒号放行 username=`core:<sub>`）。 */
const MENTION_BOUNDARY = /[\s，。！？、：；,.!?()[\]{}<>"'“”‘’《》〈〉「」【】…—～`|/\\*+=&%$#^]/

export function isMentionBoundary(char: string | undefined): boolean {
  return char === undefined || MENTION_BOUNDARY.test(char)
}

/** value 中是否出现被边界包裹的 `@name`（逐位置比较，天然支持冒号与中文）。 */
export function textMentionsName(value: string, name: string): boolean {
  for (let at = value.indexOf('@'); at !== -1; at = value.indexOf('@', at + 1)) {
    if (mentionLengthAt(value, name, at) >= 0) return true
  }
  return false
}

/**
 * value[at] 为 `@` 时，若其后紧跟被边界包裹的 name 则返回 `@name` 长度，否则 -1。
 * 只在给定位置精确比对，不后扫后续 `@`——调用方（splitMentionSegments）按位置
 * 消费返回长度，命中位置漂移会把别人的显示名错标到当前片段（实测踩坑：相邻两条
 * token 第二条显示第一条的名字）。
 */
function mentionLengthAt(value: string, name: string, at: number): number {
  const target = name.toLowerCase()
  if (!target || value[at] !== '@') return -1
  const end = at + 1 + target.length
  if (end > value.length) return -1
  if (value.slice(at + 1, end).toLowerCase() !== target) return -1
  if (!isMentionBoundary(value[at - 1]) || !isMentionBoundary(value[end])) return -1
  return target.length + 1
}

export interface MentionSegment {
  text: string
  /** true = 命中提及名的 `@name` 片段（渲染高亮）。 */
  mention: boolean
  /** 命中的提及名（未命中为 undefined）；调用方据此把显示文本换成展示名（#347 token 与显示分离）。 */
  matchedName?: string
}

/**
 * 把文本按提及命中切成渲染片段：命中片段 mention=true。
 * names 传提及候选名集合（username + displayName）；同位置多名字命中取最长，
 * 未命中任何名字的 `@` 保留原样（普通文本）。
 */
export function splitMentionSegments(value: string, names: string[]): MentionSegment[] {
  const sorted = [...new Set(names.filter((name) => name))].sort((a, b) => b.length - a.length)
  const segments: MentionSegment[] = []
  let plain = ''
  let index = 0
  while (index < value.length) {
    if (value[index] !== '@') {
      plain += value[index]
      index += 1
      continue
    }
    let matched = -1
    let matchedName: string | undefined
    for (const name of sorted) {
      const length = mentionLengthAt(value, name, index)
      if (length > 0 && (matched < 0 || length > matched)) {
        matched = length
        matchedName = name
      }
    }
    if (matched > 0) {
      if (plain) segments.push({ text: plain, mention: false })
      plain = ''
      segments.push({ text: value.slice(index, index + matched), mention: true, matchedName })
      index += matched
    } else {
      plain += value[index]
      index += 1
    }
  }
  if (plain) segments.push({ text: plain, mention: false })
  return segments
}

/**
 * 频道列表预览用：把 `@username` token 换成 `@displayName`（只换显示，发送/复核仍是 token）。
 * 与 worker mentions.js 的 replaceMentionTokens 同口径（splitMentionSegments 内部已做最长优先 + 词边界）。
 */
export function replaceMentionNames(value: string, mentions: { username: string; displayName: string }[]): string {
  const names = [...new Set(mentions.map((mention) => mention.username).filter(Boolean))]
  if (names.length === 0) return value
  const labels = new Map(mentions.map((mention) => [mention.username.toLowerCase(), mention.displayName]))
  return splitMentionSegments(value, names)
    .map((segment) => (segment.mention ? `@${labels.get(segment.matchedName!.toLowerCase()) ?? segment.text}` : segment.text))
    .join('')
}
