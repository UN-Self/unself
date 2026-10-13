// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import { createAttachmentSender } from '../src/lib/attachment-sender'
import type { Attachment } from '../src/lib/types'

const attachment: Attachment = { key: '1/a.png', name: 'a.png', type: 'image/png', size: 1, url: '/files/1%2Fa.png' }

describe('附件提交编排', () => {
  it('消息发送失败后重试复用上传结果，并保留文字与提及', async () => {
    const upload = vi.fn().mockResolvedValue(attachment)
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined)
    const submit = createAttachmentSender({ getRoomKey: () => 'dm.1', upload, send })
    const file = new File(['x'], 'a.png')
    await expect(submit(file, '说明', [2])).rejects.toThrow('offline')
    await submit(file, '新说明', [3])
    expect(upload).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith({ content: '新说明', attachment, mentionUserIds: [3] })
  })

  it('上传失败可重试，上传期间切换会话不会误发至新会话', async () => {
    let room = 'dm.1'
    let finish!: (value: Attachment) => void
    const upload = vi.fn().mockRejectedValueOnce(new Error('upload offline'))
      .mockImplementationOnce(() => new Promise<Attachment>((resolve) => { finish = resolve }))
    const send = vi.fn()
    const submit = createAttachmentSender({ getRoomKey: () => room, upload, send })
    const file = new File(['x'], 'a.png')
    await expect(submit(file, '', [])).rejects.toThrow('upload offline')
    const pending = submit(file, '', [])
    room = 'dm.2'
    finish(attachment)
    await expect(pending).rejects.toThrow('会话已切换')
    expect(send).not.toHaveBeenCalled()
  })

  it('离开后再回到同一会话，旧输入组件的上传也不能自动发出', async () => {
    const controller = new AbortController()
    const upload = vi.fn(async () => { controller.abort(); return attachment })
    const send = vi.fn()
    const submit = createAttachmentSender({ getRoomKey: () => 'dm.1', upload, send })
    await expect(submit(new File(['x'], 'a.png'), '', [], controller.signal)).rejects.toThrow('会话已切换')
    expect(send).not.toHaveBeenCalled()
  })
})
