// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 壳侧模块桥（#12，§5.2 握手）：
 * ① iframe 内 SDK 发 {type:'ready'}（origin 校验 = 模块 entry origin）
 * ② 壳调 POST /api/modules/:id/token（会话鉴权，#3）
 * ③ 壳 postMessage {type:'token', token} 给 iframe（targetOrigin = 模块 origin）
 * 模块 SDK（#8）静默续期时重发 ready，本桥再次走 ②③。
 */
import { fetchModuleToken, type ApiError } from './token-api'
import { SdkMessageSchema } from '@unself/contracts'

export interface BridgeHandle {
  detach: () => void
}

/** 挂载桥：监听该 iframe 的 ready 并供 token。返回句柄用于卸载。 */
export function attachModuleBridge(options: {
  iframe: HTMLIFrameElement
  moduleId: string
  /** iframe 内容的 origin（同域路径 → 实例 origin；第三方 → 其域名）。 */
  frameOrigin: string
  /** token 下发失败/超时回调（显示异常卡）。 */
  onError?: (error: ApiError | Error) => void
  /** token 成功下发回调（可用于清除超时状态）。 */
  onToken?: () => void
}): BridgeHandle {
  let detached = false

  const onMessage = async (event: MessageEvent) => {
    if (detached || event.origin !== options.frameOrigin) return
    if (event.source !== options.iframe.contentWindow) return
    const parsed = SdkMessageSchema.safeParse(event.data)
    if (!parsed.success || parsed.data.type !== 'ready') return

    try {
      const issued = await fetchModuleToken(options.moduleId)
      if (detached) return
      options.iframe.contentWindow?.postMessage(
        { type: 'token', token: issued.token },
        options.frameOrigin,
      )
      options.onToken?.()
    } catch (err) {
      options.onError?.(err as ApiError)
    }
  }

  window.addEventListener('message', onMessage)
  return {
    detach: () => {
      detached = true
      window.removeEventListener('message', onMessage)
    },
  }
}

/** 解析 frame origin：同域路径 → 当前 origin；绝对 URL → 其 origin；坏值 null。 */
export function frameOriginFor(entry: string | null | undefined, baseURL?: string): string | null {
  if (!entry) return null
  try {
    const base = baseURL ?? globalThis.location?.origin
    if (!base) return null
    const url = new URL(entry, base)
    return url.origin
  } catch {
    return null
  }
}
