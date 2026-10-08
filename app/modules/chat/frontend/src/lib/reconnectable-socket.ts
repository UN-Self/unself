// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 长连接生命周期管理：连接断开后退避重连，空闲期间用应用层 ping/pong
 * 发现半开连接。业务层只接收业务帧，不需要重复实现连接状态机。
 */

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error'

export interface ReconnectableSocketHandle {
  close(): void
  send?(text: string): void
}
interface RawSocketHandlers {
  onMessage: (frame: unknown) => void
  onStatus: (status: 'connecting' | 'open' | 'closed' | 'error') => void
}

interface ReconnectableSocketOptions {
  getToken: () => string | null
  connect: (token: string, handlers: RawSocketHandlers) => ReconnectableSocketHandle
  onMessage: (frame: unknown) => void
  onStatus: (status: SocketStatus) => void
  /** 探活间隔；生产值保持远大于普通消息频率，避免无谓唤醒 DO。 */
  heartbeatMs?: number
  /** 单次重连最长等待；避免网络故障时快速重试打满边缘。 */
  maxReconnectMs?: number
}

const PING_FRAME = JSON.stringify({ protocolVersion: 1, type: 'ping' })
const PONG_TYPE = 'pong'
const DEFAULT_HEARTBEAT_MS = 45_000
const DEFAULT_MAX_RECONNECT_MS = 30_000

function reconnectDelay(attempt: number, maxReconnectMs: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), maxReconnectMs)
}

/**
 * 创建一条可恢复的 WebSocket 连接。
 * - 初次连接和重连都读取最新 token；
 * - 同一次断线只安排一个定时器；
 * - close() 是终态，旧 socket 的迟到事件不会重新拉起连接；
 * - ping/pong 只在 socket 支持 send 时启用。
 */
export function openReconnectableSocket(
  options: ReconnectableSocketOptions,
): ReconnectableSocketHandle {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const maxReconnectMs = options.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS

  let stopped = false
  let attempt = 0
  let generation = 0
  let current: ReconnectableSocketHandle | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let pongTimer: ReturnType<typeof setTimeout> | null = null
  let awaitingPong = false

  const clearHeartbeat = (): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (pongTimer) clearTimeout(pongTimer)
    heartbeatTimer = null
    pongTimer = null
    awaitingPong = false
  }

  const failConnection = (connectionGeneration: number): void => {
    if (stopped || connectionGeneration !== generation) return
    clearHeartbeat()
    current = null
    attempt += 1
    options.onStatus('reconnecting')
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      open()
    }, reconnectDelay(attempt, maxReconnectMs))
  }

  const startHeartbeat = (connectionGeneration: number, socket: ReconnectableSocketHandle): void => {
    clearHeartbeat()
    if (!socket.send || heartbeatMs <= 0) return
    heartbeatTimer = setInterval(() => {
      if (stopped || connectionGeneration !== generation || current !== socket) return
      if (awaitingPong) {
        socket.close()
        return
      }
      awaitingPong = true
      socket.send?.(PING_FRAME)
      pongTimer = setTimeout(() => {
        if (stopped || connectionGeneration !== generation || current !== socket) return
        socket.close()
      }, Math.max(1_000, Math.floor(heartbeatMs / 3)))
    }, heartbeatMs)
  }

  const open = (): void => {
    if (stopped) return
    const token = options.getToken()
    if (!token) {
      options.onStatus('error')
      failConnection(generation)
      return
    }

    const connectionGeneration = ++generation
    options.onStatus(attempt === 0 ? 'connecting' : 'reconnecting')
    let failed = false
    const socket = options.connect(token, {
      onStatus: (status) => {
        if (stopped || connectionGeneration !== generation) return
        if (status === 'open') {
          failed = false
          attempt = 0
          current = socket
          options.onStatus('open')
          startHeartbeat(connectionGeneration, socket)
          return
        }
        if (status === 'connecting') return
        if (failed) return
        failed = true
        failConnection(connectionGeneration)
      },
      onMessage: (frame) => {
        if (stopped || connectionGeneration !== generation) return
        if (
          typeof frame === 'object' &&
          frame !== null &&
          !Array.isArray(frame) &&
          (frame as { type?: unknown }).type === PONG_TYPE
        ) {
          awaitingPong = false
          if (pongTimer) clearTimeout(pongTimer)
          pongTimer = null
          return
        }
        options.onMessage(frame)
      },
    })
    current = socket
  }

  const handle: ReconnectableSocketHandle = {
    close() {
      if (stopped) return
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      clearHeartbeat()
      const socket = current
      current = null
      socket?.close()
      options.onStatus('closed')
    },
    send(text: string) {
      current?.send?.(text)
    },
  }

  open()
  return handle
}
