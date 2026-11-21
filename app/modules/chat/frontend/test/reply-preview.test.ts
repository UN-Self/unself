// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { replyAuthorOf, replyPreviewOf } from '../src/lib/reply-preview'
import type { Message } from '../src/lib/types'

/**
 * 引用摘要纯函数（L1 抽取）：content 第一行 / 超 60 字省略 / 纯附件回退附件名 / deleted 占位降级。
 * 两问检验：改坏截断或附件回退 → 红；调整调用方不改本函数 → 绿。
 */

const baseMessage = (over: Partial<Message> = {}): Message => ({
  id: 11,
  content: '你好，世界',
  mentionUserIds: [],
  mentions: [],
  createdAt: '2026-09-16T09:07:00',
  source: 'local',
  sender: { kind: 'local', id: 2, username: 'bob', displayName: '鲍勃', avatarUrl: '', source: 'local' },
  attachment: null,
  ...over,
})

describe('replyPreviewOf', () => {
  it('取 content 第一行；多行只留首行', () => {
    expect(replyPreviewOf(baseMessage({ content: '第一行\n第二行' }))).toBe('第一行')
  })

  it('超 60 字省略号截断', () => {
    const long = 'x'.repeat(61)
    const preview = replyPreviewOf(baseMessage({ content: long }))
    expect(preview).toBe('x'.repeat(60) + '…')
  })

  it('纯附件消息（content 空）回退到附件名', () => {
    const msg = baseMessage({
      content: '',
      attachment: { key: 'k', name: '报告.pdf', type: 'application/pdf', size: 2048, url: '/f/1' },
    })
    expect(replyPreviewOf(msg)).toBe('报告.pdf')
  })

  it('deleted 占位返回 undefined', () => {
    expect(replyPreviewOf({ id: 99, deleted: true })).toBeUndefined()
  })

  it('null/undefined 返回 undefined', () => {
    expect(replyPreviewOf(null)).toBeUndefined()
    expect(replyPreviewOf(undefined)).toBeUndefined()
  })
})

describe('replyAuthorOf', () => {
  it('返回发言人 displayName', () => {
    expect(replyAuthorOf(baseMessage())).toBe('鲍勃')
  })

  it('deleted 占位返回 undefined', () => {
    expect(replyAuthorOf({ id: 99, deleted: true })).toBeUndefined()
  })
})