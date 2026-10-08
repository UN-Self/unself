// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openReconnectableSocket,
  type ReconnectableSocketHandle,
  type SocketStatus,
} from '../src/lib/reconnectable-socket'

type RawHandlers = {
  onMessage: (frame: unknown) => void
  onStatus: (status: 'connecting' | 'open' | 'closed' | 'error') => void
}

type TestSocket = ReconnectableSocketHandle & {
  token: string
  handlers: RawHandlers
  sent: string[]
}

function makeSocket(token: string, handlers: RawHandlers): TestSocket {
  const sent: string[] = []
  const socket: TestSocket = {
    token,
    handlers,
    sent,
    close: vi.fn(() => handlers.onStatus('closed')),
    send: vi.fn((text: string) => sent.push(text)),
  }
  return socket
}

describe('openReconnectableSocket', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('断线只安排一次退避重连，并在新连接建立后读取最新 token', () => {
    vi.useFakeTimers()
    let token = 't1'
    const sockets: TestSocket[] = []
    const statuses: SocketStatus[] = []
    const handle = openReconnectableSocket({
      getToken: () => token,
      connect: (nextToken, handlers) => {
        const socket = makeSocket(nextToken, handlers)
        sockets.push(socket)
        return socket
      },
      onMessage: () => {},
      onStatus: (status) => statuses.push(status),
      heartbeatMs: 0,
      maxReconnectMs: 2_000,
    })

    expect(sockets).toHaveLength(1)
    sockets[0]!.handlers.onStatus('open')
    token = 't2'
    sockets[0]!.handlers.onStatus('closed')
    sockets[0]!.handlers.onStatus('closed')
    expect(sockets).toHaveLength(1)
    expect(statuses).toContain('reconnecting')

    vi.advanceTimersByTime(999)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
    expect(sockets[1]!.token).toBe('t2')

    sockets[1]!.handlers.onStatus('open')
    handle.close()
    vi.advanceTimersByTime(10_000)
    expect(sockets).toHaveLength(2)
    expect(statuses.at(-1)).toBe('closed')
  })

  it('探活收到 pong 时保持连接，未收到 pong 时关闭并进入重连', () => {
    vi.useFakeTimers()
    const sockets: TestSocket[] = []
    const handle = openReconnectableSocket({
      getToken: () => 'tok',
      connect: (token, handlers) => {
        const socket = makeSocket(token, handlers)
        sockets.push(socket)
        return socket
      },
      onMessage: vi.fn(),
      onStatus: () => {},
      heartbeatMs: 3_000,
      maxReconnectMs: 2_000,
    })

    sockets[0]!.handlers.onStatus('open')
    vi.advanceTimersByTime(3_000)
    expect(sockets[0]!.sent).toEqual(['{"protocolVersion":1,"type":"ping"}'])
    sockets[0]!.handlers.onMessage({ protocolVersion: 1, type: 'pong' })
    vi.advanceTimersByTime(1_000)
    expect(sockets[0]!.close).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2_000)
    expect(sockets[0]!.sent).toHaveLength(2)
    vi.advanceTimersByTime(1_000)
    expect(sockets[0]!.close).toHaveBeenCalledTimes(1)
    handle.close()
  })
})
