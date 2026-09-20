// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest'

/**
 * session 测试替身（#220 抽自 session.test.ts 同款形状）：假 window + 手造 JWT。
 * 与 session.test.ts 保持一致的两件套——这里只给 read-receipts.test.ts 复用。
 */

export const CORE_ORIGIN = 'https://team.example.com'

type Listener = (event: { origin: string; data: unknown }) => void

export function installFakeWindow(origin = CORE_ORIGIN, ancestorOrigins?: string[]): {
  postMessage: ReturnType<typeof vi.fn>
  dispatch: (data: unknown, from?: string) => void
} {
  const postMessage = vi.fn()
  const listeners = new Set<Listener>()
  const locationLike = { origin, ...(ancestorOrigins ? { ancestorOrigins } : {}) }
  vi.stubGlobal('window', {
    location: locationLike,
    parent: { postMessage },
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
  })
  // session.ts 的 coreOrigin 走 SDK resolveShellOrigin()（#277）：读 globalThis.location
  // ——必须一起 stub；ancestorOrigins 给的是跨子域 iframe 的壳 origin（模块自有子域装载）。
  vi.stubGlobal('location', locationLike)
  return {
    postMessage,
    dispatch: (data, from) => {
      for (const listener of listeners) listener({ origin: from ?? origin, data })
    },
  }
}

/** 手造 JWT：payload = {iss, sub, aud:'chat', iat, exp}。 */
export function makeToken(overrides: Partial<{ iat: number; exp: number; sub: string }> = {}): string {
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
