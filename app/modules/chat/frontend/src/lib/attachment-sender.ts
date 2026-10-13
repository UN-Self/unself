// SPDX-License-Identifier: AGPL-3.0-only
import type { Attachment } from './types'

/** Upload only on submit. Reuse successful uploads when message delivery needs retry. */
export function createAttachmentSender(options: {
  getRoomKey: () => string | null
  upload: (file: File) => Promise<Attachment | null | undefined>
  send: (input: { content: string; attachment: Attachment; mentionUserIds: number[] }) => Promise<void>
}) {
  const uploaded = new WeakMap<File, Attachment>()
  return async (file: File, content: string, mentionUserIds: number[], signal?: AbortSignal): Promise<void> => {
    const room = options.getRoomKey()
    if (!room) throw new Error('请先选择会话')
    let attachment = uploaded.get(file)
    if (!attachment) {
      attachment = await options.upload(file) ?? undefined
      if (!attachment) throw new Error('上传失败，请重试')
      uploaded.set(file, attachment)
    }
    if (signal?.aborted || options.getRoomKey() !== room) throw new Error('会话已切换，附件未发送')
    await options.send({ content, attachment, mentionUserIds })
    uploaded.delete(file)
  }
}
