// SPDX-License-Identifier: AGPL-3.0-only
import { replaceMentionNames } from './mention-text'
import type { Message } from './types'

/** replyTo 形态：完整消息 或 已删除占位（仅 id+deleted）。 */
type ReplyRef = Message | { id: number; deleted: boolean } | null | undefined

/**
 * @token 重写（展示层兜底）：正文里存的是 `@username`（core:<sub> 稳定 token），
 * 引用块是纯文本渲染，有 mentions 映射时换 `@displayName`（mention-text 的共享口径）；
 * live 读路径已由 worker 重写（messages.js rewriteMentionTokens），此处覆盖 mock 与未升级数据。
 */
function mentionDisplayText(reply: ReplyRef, text: string): string {
  if (!reply || !('mentions' in reply) || !Array.isArray(reply.mentions)) return text
  return replaceMentionNames(text, reply.mentions)
}

/**
 * 引用摘要：content 第一行，超 60 字省略；纯附件消息回退到附件名。
 * deleted 占位 / 无内容返回 undefined（调用方决定降级文案）。
 */
export function replyPreviewOf(reply: ReplyRef): string | undefined {
  if (!reply || reply.deleted || !('content' in reply)) return undefined
  if (typeof reply.content === 'string') {
    const firstLine = mentionDisplayText(reply, reply.content).split('\n')[0] ?? ''
    if (firstLine) return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
  }
  // 纯图片/文件消息：content 为空，用附件名占位，避免引用块只剩发言人名；语音上传名是 uuid 串，回退固定文案
  return attachmentFallbackOf(reply)
}

/** 纯附件消息的占位文本：语音用固定文案（上传名是 uuid 串没有可读性），其余用附件名。 */
function attachmentFallbackOf(reply: ReplyRef): string | undefined {
  if (!reply || !('attachment' in reply) || !reply.attachment) return undefined
  if (reply.attachment.kind === 'voice') return '[语音]'
  return reply.attachment.name || '[附件]'
}

/** 引用发言人名（引用块第一行灰字）。deleted 占位无 sender，返回 undefined。 */
export function replyAuthorOf(reply: ReplyRef): string | undefined {
  if (!reply || reply.deleted || !('sender' in reply)) return undefined
  return reply.sender.displayName
}
/** 引用全文（气泡引用块）：content 全文（@token 已换显示名，多行换行显示）；纯附件消息回退占位文本；deleted 占位 undefined。 */
export function replyFullTextOf(reply: ReplyRef): string | undefined {
  if (!reply || reply.deleted || !('content' in reply)) return undefined
  if (typeof reply.content === 'string' && reply.content.trim()) return mentionDisplayText(reply, reply.content)
  return attachmentFallbackOf(reply)
}
