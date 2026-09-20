// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_THEME } from '@unself/contracts'

import { attachModuleBridge, frameOriginFor } from './module-bridge'

const { fetchModuleTokenMock } = vi.hoisted(() => ({
  fetchModuleTokenMock: vi.fn(),
}))

vi.mock('./token-api', () => ({
  fetchModuleToken: fetchModuleTokenMock,
}))

const BASE = 'https://team.example.com'

describe('frameOriginFor（桥的 origin 校验输入）', () => {
  it('同域完整 URL → 实例 origin', () => {
    expect(frameOriginFor(`${BASE}/m/hello/`, BASE)).toBe(BASE)
  })

  it('相对路径 → 以 baseURL 解析', () => {
    expect(frameOriginFor('/m/hello/', BASE)).toBe(BASE)
  })

  it('第三方域名 → 其自身 origin（§5.3 逃生口）', () => {
    expect(frameOriginFor('https://chat.other.example/m/chat/', BASE)).toBe(
      'https://chat.other.example',
    )
  })

  it('坏值 → null', () => {
    expect(frameOriginFor(null, BASE)).toBeNull()
    expect(frameOriginFor('', BASE)).toBeNull()
    // 无 baseURL 且非浏览器环境（globalThis.location 缺失）
    const saved = globalThis.location
    delete (globalThis as { location?: unknown }).location
    expect(frameOriginFor('/m/hello/')).toBeNull()
    globalThis.location = saved
  })
})

describe('attachModuleBridge（通道 B 主题下发 + token 下发，§6.5.5）', () => {
  const TRUSTED_ORIGIN = 'https://mod.example'
  let handlers: Array<(event: MessageEvent) => void>
  let postMessage: ReturnType<typeof vi.fn>
  let fakeWindow: { postMessage: typeof postMessage }

  beforeEach(() => {
    handlers = []
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (event: MessageEvent) => void) => {
        if (type === 'message') handlers.push(fn)
      },
      removeEventListener: (type: string, fn: (event: MessageEvent) => void) => {
        const index = handlers.indexOf(fn)
        if (index >= 0) handlers.splice(index, 1)
      },
    })
    postMessage = vi.fn()
    fakeWindow = { postMessage }
    fetchModuleTokenMock.mockReset()
    fetchModuleTokenMock.mockResolvedValue({ token: 'test-token' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function attach(more: Record<string, unknown> = {}) {
    return attachModuleBridge({
      iframe: { contentWindow: fakeWindow } as unknown as HTMLIFrameElement,
      moduleId: 'hello',
      frameOrigin: TRUSTED_ORIGIN,
      tokens: DEFAULT_THEME,
      ...more,
    })
  }

  /** 给第一个监听器投递一条事件（模拟 iframe 的 message）。 */
  function dispatch(
    data: unknown,
    overrides: { origin?: string; source?: unknown } = {},
  ): void {
    const listener = handlers[0]
    if (!listener) return
    listener({
      origin: overrides.origin ?? TRUSTED_ORIGIN,
      source: overrides.source ?? fakeWindow,
      data,
    } as unknown as MessageEvent)
  }

  it('可信 ready：先发 {type:tokens} 随后 {type:token}（mock.calls 断言顺序）', async () => {
    const handle = attach()
    dispatch({ type: 'ready' })
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2))
    expect(postMessage.mock.calls[0]).toEqual([{ type: 'tokens', tokens: DEFAULT_THEME }, TRUSTED_ORIGIN])
    expect(postMessage.mock.calls[1]).toEqual([{ type: 'token', token: 'test-token' }, TRUSTED_ORIGIN])
    handle.detach()
  })

  it('token 接口失败：tokens 已投递、无 token、onError 触发、onToken 不触发', async () => {
    fetchModuleTokenMock.mockRejectedValue(new Error('网络不可用'))
    const onError = vi.fn()
    const onToken = vi.fn()
    const handle = attach({ onError, onToken })
    dispatch({ type: 'ready' })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(postMessage.mock.calls[0]).toEqual([{ type: 'tokens', tokens: DEFAULT_THEME }, TRUSTED_ORIGIN])
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(onToken).not.toHaveBeenCalled()
    handle.detach()
  })

  it('恶意 origin 的 ready → 零 postMessage', () => {
    const handle = attach()
    dispatch({ type: 'ready' }, { origin: 'https://evil.example' })
    expect(postMessage).not.toHaveBeenCalled()
    handle.detach()
  })

  it('source 不是 iframe.contentWindow（别帧冒充）→ 零 postMessage', () => {
    const handle = attach()
    dispatch({ type: 'ready' }, { source: {} })
    expect(postMessage).not.toHaveBeenCalled()
    handle.detach()
  })

  it('非 ready 消息（token 回程/乱数据）→ 零 postMessage', () => {
    const handle = attach()
    dispatch({ type: 'token', token: 'x' })
    dispatch({ type: 'tokens', tokens: DEFAULT_THEME })
    dispatch({ nope: true })
    expect(postMessage).not.toHaveBeenCalled()
    handle.detach()
  })

  it('detach 后旧监听不再响应 ready', async () => {
    const handle = attach()
    const listener = handlers[0]!
    handle.detach()
    // detach 已移除监听器；直接调用旧引用验证 detached 守卫
    listener({
      origin: TRUSTED_ORIGIN,
      source: fakeWindow,
      data: { type: 'ready' },
    } as unknown as MessageEvent)
    await Promise.resolve()
    expect(postMessage).not.toHaveBeenCalled()
    expect(fetchModuleTokenMock).not.toHaveBeenCalled()
  })
})
