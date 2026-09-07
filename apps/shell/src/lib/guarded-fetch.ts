// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 401 全局拦截（#11）：会话过期/失效时统一跳登录页并携带 next 回跳目标。
 * 登出动作与登录页自身用原生 fetch，不经过本拦截。
 */

let intercepting = false

export function installAuthGuard(onUnauthorized?: (next: string) => void): void {
  if (intercepting) return
  intercepting = true
  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input, init) => {
    const res = await originalFetch(input, init)
    if (res.status === 401) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      // 排除登录/会话查询本身，避免循环跳转
      const isAuthPath = url.startsWith('/api/auth/') || url.startsWith('/api/me') || url.startsWith('/api/setup/')
      if (!isAuthPath && !window.location.pathname.startsWith('/login')) {
        const next = `${window.location.pathname}${window.location.search}`
        onUnauthorized?.(next)
      }
    }
    return res
  }
}
