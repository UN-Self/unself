// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatStore } from '../src/lib/chat-store'
import { createMockChatApi } from '../src/lib/mock-api'
import { createChatStorage } from '../src/lib/storage'

function fixture(report = vi.fn(async (_kind: string, _room: number, _ids: number[]) => {})) {
  const api = createMockChatApi()
  api.getMessages = async () => ({ messages: [], pinnedMessage: null, room: { id: 1, kind: 'public', name: 'general', description: '' } })
  api.reportMessagesRead = report
  const store = createChatStore({ api, myUserId: () => 1, getToken: () => 'test',
    storage: createChatStorage({ getItem: () => null, setItem() {}, removeItem() {} }) })
  return { store, report }
}

afterEach(() => vi.useRealTimers())

describe('已读上报的请求预算', () => {
  it('连续可见事件合成一次请求；每批不超过 200 条，成功项不再发送', async () => {
    vi.useFakeTimers()
    const { store, report } = fixture()
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    for (let id = 1; id <= 205; id++) await store.recordVisibleRead([id, id])
    expect(report).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.calls.map((call) => call[2].length)).toEqual([200, 5])
    expect(new Set(report.mock.calls.flatMap((call) => call[2])).size).toBe(205)
    await store.recordVisibleRead([1, 205])
    await vi.advanceTimersByTimeAsync(1000)
    expect(report).toHaveBeenCalledTimes(2)
    store.closeSockets()
  })

  it('请求未返回时同一消息不重复发送；失败不形成自动重试循环', async () => {
    vi.useFakeTimers()
    let reject!: (error: Error) => void
    const report = vi.fn((_kind: string, _room: number, _ids: number[]) => new Promise<void>((_resolve, fail) => { reject = fail }))
    const { store } = fixture(report)
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    await store.recordVisibleRead([10])
    await vi.advanceTimersByTimeAsync(1000)
    await store.recordVisibleRead([10])
    await vi.advanceTimersByTimeAsync(1000)
    expect(report).toHaveBeenCalledTimes(1)
    reject(new Error('offline'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(report).toHaveBeenCalledTimes(1)
    store.closeSockets()
  })

  it('切换会话取消旧批次，不把旧消息报给新会话', async () => {
    vi.useFakeTimers()
    const { store, report } = fixture()
    await store.openRoom({ kind: 'public', id: 1 }, 'general')
    await store.recordVisibleRead([10])
    await store.openRoom({ kind: 'private', id: 2 }, 'group')
    await store.recordVisibleRead([20])
    await vi.advanceTimersByTimeAsync(1000)
    expect(report.mock.calls).toEqual([['private', 2, [20]]])
    store.closeSockets()
  })
})
