// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块 SDK 会话装配（#218 T2）：createModuleSDK（@unself/module-sdk）接进 chat——
 * ① ready 握手 → ② 壳下发 token（origin 校验=壳 origin）→ ③ 静默续期循环（SDK 现成能力）
 * → ④ token/claims 投影给调用方（myUserId = claims.sub 解出的核心用户 id）。
 *
 * 独立开发态（dev-shim.html 宿主）：SDK 一切照常——shim 顶替壳发 token/tokens 消息，
 * 前端无需感知。coreOrigin 取 location.origin（同源路径制装载，architecture.md §模块契约）。
 *
 * token 只存内存（本文件闭包），localStorage 绝不落凭证；续期换新后 latestToken 即新值。
 */
import { createModuleSDK } from '@unself/module-sdk'
import type { ModuleSDK } from '@unself/module-sdk'

export interface ChatSession {
  /** SDK 实例（navigate/notify/theme 能力后续接入用）。 */
  sdk: ModuleSDK
  /** 当前生效 token（续期后自动换新）；未握手完成时为 null。 */
  getToken(): string | null
  /** 当前登录用户 id（claims.sub；未握手 = 0）。 */
  getUserId(): number
  /** 握手完成（首次 token 到达）resolve；超时 reject 人话错误。 */
  handshake(timeoutMs?: number): Promise<void>
  /** 停止续期循环（卸载时）。 */
  dispose(): void
}

export interface CreateChatSessionOptions {
  /** 模块 id（manifest 契约，aud=chat）。 */
  moduleId?: string
}

/** 握手默认超时：与壳模块加载异常规范同量级（15s）。 */
export const HANDSHAKE_TIMEOUT_MS = 15_000

/** 从 token 解出当前用户 id（claims.sub 是核心内部稳定用户 id，数字形态；坏值 0）。 */
export function userIdFromToken(decode: (token: string) => { sub: string }, token: string | null): number {
  if (!token) return 0
  try {
    const id = Number(decode(token).sub)
    return Number.isFinite(id) ? id : 0
  } catch {
    return 0
  }
}

/** 创建 chat 会话（SDK 握手 + 静默续期装配）。 */
export function createChatSession(options: CreateChatSessionOptions = {}): ChatSession {
  const moduleId = options.moduleId ?? 'chat'
  // 同源路径制：iframe 内 location.origin 即壳 origin（SDK 入站 token 的校验锚点）
  const coreOrigin = globalThis.location?.origin
  const sdk = createModuleSDK({ moduleId, coreOrigin })

  let latestToken: string | null = null
  let latestUserId = 0
  let waiter: ((token: string) => void) | null = null

  const adopt = (token: string): void => {
    latestToken = token
    try {
      const claims = sdk.decodeContext(token)
      const id = Number(claims.sub)
      latestUserId = Number.isFinite(id) ? id : 0
    } catch {
      latestUserId = 0
    }
    waiter?.(token)
    waiter = null
  }

  sdk.ready()
  // 首 token 通道：waitForToken 在壳 origin 校验下解析第一个 token；未握手时悬挂无害
  void sdk
    .waitForToken()
    .then(adopt)
    .catch(() => {
      /* 无 coreOrigin 等配置错误：由 handshake 超时统一兑成人话错误 */
    })
  // 静默续期（§5.2 ⑥）：SDK 到期自动重发 ready → 壳换发新 token → adopt 更新内存 token
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
        // 首个 token 到手：启动静默续期循环（到期前重发 ready 换新 token）
        sdk.startTokenLoop(token, onToken)
        resolve()
      }
    })

  return {
    sdk,
    getToken: () => latestToken,
    getUserId: () => latestUserId,
    handshake,
    dispose: () => {
      waiter = null
      sdk.stopTokenLoop()
    },
  }
}
