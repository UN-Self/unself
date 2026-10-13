// SPDX-License-Identifier: AGPL-3.0-only
import type { Message } from './types'

/** 保留消息位置和作者；清除所有可重新展示正文的字段。 */
export function concealDeletedMessage(message: Message): Message {
  return {
    ...message,
    deleted: true,
    content: '',
    attachment: null,
    blocks: undefined,
    mentions: [],
    mentionUserIds: [],
    replyTo: undefined,
    replyToMessageId: undefined,
    readReceipts: undefined,
  }
}

/** 撤回事件可能早于分页/发送回包；后到的旧副本不能恢复内容。 */
export function reconcileDeletedMessage(message: Message, deletedIds: Set<number>, notices = new Map<number, NonNullable<Message['deletion']>>()): Message {
  if (message.deleted) deletedIds.add(message.id)
  if (deletedIds.has(message.id)) return concealDeletedMessage({ ...message, deletion: notices.get(message.id) ?? message.deletion })
  const replyId = message.replyToMessageId ?? message.replyTo?.id
  if (replyId && deletedIds.has(replyId)) {
    return { ...message, replyTo: { id: replyId, deleted: true } }
  }
  return message
}

export function deletionLabel(message: Message): string {
  const notice = message.deletion
  const actor = notice?.actorName || message.sender.displayName || '已注销用户'
  return `${actor} ${notice?.action === 'removed' ? '移除' : '撤回'}了一条消息`
}
