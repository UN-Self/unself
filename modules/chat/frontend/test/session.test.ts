// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createChatSession, userIdFromToken } from '../src/lib/session'

/**
 * SDK 会话装配行为（#218 T2）：握手拿 token → 启动静默续期 → 续期 token 换新；
 * userId 从 claims.sub 解出；token 绝不落 localStorage（内存态）。
 * 两问检验：改坏握手超时/续期启动 → 红；重构装配实现 → 绿。
 */

const CORE_ORIGIN = 'https://team.example.com'

type Listener = (event: { origin: string; data: unknown }) => void

function installFakeWindow(origin = CORE_ORIGIN): {
  postMessage: ReturnType<typeof vi.fn>
  dispatch: (data: unknown, from?: string) => void
} {
  const postMessage = vi.fn()
  const listeners = new Set<Listener>()
  vi.stubGlobal('window', {
    location: { origin },
    parent: { postMessage },
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
  })
  // session.ts 的 coreOrigin 读 globalThis.location.origin（同源装载语义）——必须一起 stub
  vi.stubGlobal('location', { origin })
  // session.ts 读 globalThis.location.origin 作 coreOrigin（同源装载语义）
  vi.stubGlobal('location', { origin })
  return {
    postMessage,
    dispatch: (data, from) => {
      for (const listener of listeners) listener({ origin: from ?? origin, data })
    },
  }
}

/** 手造 JWT：payload = {iss, sub:'42', aud:'chat', iat, exp}。 */
function makeToken(overrides: Partial<{ iat: number; exp: number; sub: string }> = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: 'https://core.unself.example',
    sub: '42',
    aud: 'chat',
    iat: now,
    exp: now + 600,
    ...overrides,
  }
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  return `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('createChatSession（#218 SDK 握手）', () => {
  it('handshake 收到首个 token 后 resolve，token/uid 可读', async () => {
    const fake = installFakeWindow()
    const session = createChatSession()

    const pending = session.handshake()
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    fake.dispatch({ type: 'token', token: makeToken() })
    await pending
    expect(session.getToken()).not.toBeNull()
    expect(session.getUserId()).toBe(42)
    session.dispose()
  })

  it('超时未收到 token → 人话错误（不悬挂）', async () => {
    vi.useFakeTimers()
    installFakeWindow()
    const session = createChatSession()
    // 先挂消费者再推进时钟：reject 必须有人接（否则 unhandled rejection）
    const pending = session.handshake(1_000)
    const assertion = expect(pending).rejects.toThrow('连接超时')
    await vi.advanceTimersByTimeAsync(1_001)
    await assertion
    session.dispose()
  })

  it('续期换发新 token 后 getToken 读到新值（内存态，localStorage 无凭证）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const fake = installFakeWindow()
    const session = createChatSession()

    const pending = session.handshake()
    const firstToken = makeToken()
    fake.dispatch({ type: 'token', token: firstToken })
    await pending
    expect(session.getToken()).toBe(firstToken)

    // 10 分钟 token：480s 后 SDK 重发 ready 续期 → 壳回发新 token → 内存 token 换新
    vi.advanceTimersByTime(480_000)
    expect(fake.postMessage).toHaveBeenCalledWith({ type: 'ready' }, CORE_ORIGIN)
    const renewedToken = makeToken({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })
    fake.dispatch({ type: 'token', token: renewedToken })
    expect(session.getToken()).toBe(renewedToken)

    // 凭证只存内存：localStorage 全量扫一遍不得含任何 JWT 形态字符串
    const storage = (globalThis as { localStorage?: Storage }).localStorage
    if (storage) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i) ?? ''
        expect(storage.getItem(key) ?? '').not.toContain('ey')
      }
    }
    session.dispose()
  })

  it('来自非壳 origin 的 token 不被接受（安全默认）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const fake = installFakeWindow()
    const session = createChatSession()
    // 先挂好断言再推进时钟：reject 必须有消费者（否则 unhandled rejection）
    const pending = session.handshake(2_000)
    const assertion = expect(pending).rejects.toThrow('连接超时')
    fake.dispatch({ type: 'token', token: makeToken() }, 'https://evil.example')
    await vi.advanceTimersByTimeAsync(1)
    // 仍悬挂：合法路径只有壳 origin
    expect(session.getToken()).toBeNull()
    await vi.advanceTimersByTimeAsync(2_001)
    await assertion
    session.dispose()
  })
})

describe('userIdFromToken', () => {
  it('从 claims.sub 解出数字 id；坏 token / null 回 0', () => {
    const decode = (token: string): { sub: string } => {
      const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string }
      return { sub: payload.sub }
    }
    expect(userIdFromToken(decode, makeToken({ sub: '7' }))).toBe(7)
    expect(userIdFromToken(decode, 'garbage')).toBe(0)
    expect(userIdFromToken(decode, null)).toBe(0)
  })
})
