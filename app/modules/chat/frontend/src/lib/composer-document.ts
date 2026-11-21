// SPDX-License-Identifier: AGPL-3.0-only
import type { RichInputPart } from '@unself/ui'
import type { Attachment, MessageBlock } from './types'
export interface ComposerDocument { parts: RichInputPart[]; files: Map<string, File> }
/** Keep uploads separate from editing; retries reuse uploads without flattening the document. */
export function createDocumentSender(options: {
  getRoomKey: () => string | null
  upload: (file: File) => Promise<Attachment | null | undefined>
  send: (input: { content: string; blocks: MessageBlock[]; attachment: Attachment | null; mentionUserIds: number[]; mentionAll: boolean }) => Promise<void>
}) {
  const cache = new WeakMap<File, Attachment>()
  return async (doc: ComposerDocument, mentionUserIds: number[], mentionAll: boolean, signal: AbortSignal) => {
    const room = options.getRoomKey()
    if (!room) throw new Error('请先选择会话')
    const blocks: MessageBlock[] = []
    for (const part of doc.parts) {
      if (signal.aborted || options.getRoomKey() !== room) throw new Error('会话已切换，消息未发送')
      if (part.type === 'text') { blocks.push({ ...part }); continue }
      // mention chip 在附件消息里落成文本块（token 序列化），否则 token 丢失服务端复核不到提及；
      // 绝不能走下面的附件分支（mention 的 id 是 number，files.get 恒取不到 → 误报「附件已失效」）。
      if (part.type === 'mention') { blocks.push({ type: 'text', text: `@${part.username}` }); continue }
      const file = doc.files.get(part.id)
      if (!file) throw new Error('附件已失效，请重新选择')
      let attachment = cache.get(file)
      if (!attachment) {
        attachment = await options.upload(file) ?? undefined
        if (!attachment) throw new Error('上传失败，请重试')
        cache.set(file, attachment)
      }
      blocks.push({ type: 'attachment', attachment })
    }
    if (signal.aborted || options.getRoomKey() !== room) throw new Error('会话已切换，消息未发送')
    const first = blocks.find(block => block.type === 'attachment')
    await options.send({ blocks, content: blocks.map(block => block.type === 'text' ? block.text : '\n').join('').trim(), attachment: first?.type === 'attachment' ? first.attachment : null, mentionUserIds, mentionAll })
  }
}
