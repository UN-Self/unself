// SPDX-License-Identifier: AGPL-3.0-only

/**
 * docs 模块会话装配（D7）：createModuleSDK 握手 → 收 token → 静默续期。
 *
 * 与 chat 的 session.ts 同一套语义（照抄结构，不抽公共件——两个模块各自演进）：
 * ① sdk.ready() 发出就绪 → ② 壳下发 token（origin 校验 = 壳 origin）→
 * ③ startTokenLoop 续期 → ④ token 只存内存，localStorage 绝不落凭证。
 *
 * coreOrigin 用 resolveShellOrigin() 取**壳 origin**：workers.dev 形态下模块挂自有子域，
 * 拿 location.origin 当 coreOrigin 会让 SDK 入站校验永远不中、握手必然超时。
 */
import { createModuleSDK, resolveShellOrigin } from '@unself/sdk'
import type { ModuleSDK } from '@unself/sdk'

export interface DocsSession {
  /** 当前生效 token（续期后自动换新）；未握手完成时为 null。 */
  getToken(): string | null
  /** 当前用户 id（claims.sub；未握手为空串）。 */
  getUserId(): string
  /** 握手完成（首个 token 到达）resolve；超时 reject 人话错误。 */
  handshake(timeoutMs?: number): Promise<void>
  /** 停止续期循环（组件卸载时调用）。 */
  dispose(): void
}

export interface CreateDocsSessionOptions {
  /** 模块 id（manifest 契约，aud=docs）。 */
  moduleId?: string
}

/** 握手默认超时：与壳模块加载异常规范同量级（15s）。 */
export const HANDSHAKE_TIMEOUT_MS = 15_000

/** 创建 docs 会话（SDK 握手 + 静默续期装配）。 */
export function createDocsSession(options: CreateDocsSessionOptions = {}): DocsSession {
  const moduleId = options.moduleId ?? 'docs'
  const coreOrigin = resolveShellOrigin()
  const sdk: ModuleSDK = createModuleSDK({ moduleId, coreOrigin })

  let latestToken: string | null = null
  let latestUserId = ''
  let waiter: ((token: string) => void) | null = null

  const adopt = (token: string): void => {
    latestToken = token
    latestUserId = userIdFromToken((value) => sdk.decodeContext(value), token)
    waiter?.(token)
    waiter = null
  }

  sdk.ready()
  void sdk
    .waitForToken()
    .then(adopt)
    .catch(() => {
      /* 无 coreOrigin 等配置错误：由 handshake 超时统一兑成人话错误 */
    })

  const onToken = (token: string): void => adopt(token)

  const handshake = (timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<void> =>
    new Promise((resolve, reject) => {
      if (latestToken !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        waiter = null
        reject(new Error('连接超时：未能从平台取得身份令牌'))
      }, timeoutMs)
      waiter = (token) => {
        clearTimeout(timer)
        sdk.startTokenLoop(token, onToken)
        resolve()
      }
    })

  return {
    getToken: () => latestToken,
    getUserId: () => latestUserId,
    handshake,
    dispose: () => {
      waiter = null
      sdk.stopTokenLoop()
    },
  }
}

/** Core 身份是不透明字符串；解码失败返回空串，不抛。 */
export function userIdFromToken(
  decode: (token: string) => { sub: string },
  token: string | null,
): string {
  if (!token) return ''
  try {
    const subject = decode(token).sub
    return typeof subject === 'string' && subject.trim() ? subject : ''
  } catch {
    return ''
  }
}
