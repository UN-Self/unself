// SPDX-License-Identifier: AGPL-3.0-only

/**
 * setup 路由守卫（#10）：
 * - 未激活 + 无令牌访问 /setup：放行页面（页面内展示"需要部署时输出的激活链接"提示）
 * - 未激活 + 有令牌：放行向导
 * - 已激活：本页从此不复存在——已登录重定向工作台，未登录重定向登录页
 *
 * 激活态由 GET /api/setup/status 判定（done 标记，§6.5：已激活后访问 /setup 一律重定向）。
 * 守卫用纯函数形式便于单测；async 判定在 router.beforeEach 里完成。
 */

export interface SetupGuardInput {
  /** 实例是否已激活（后端 done 标记）。 */
  setupDone: boolean
  /** URL 是否携带一次性令牌（?token=…）。 */
  hasToken: boolean
  /** 当前用户是否已登录（/api/me 200）。 */
  authenticated: boolean
}

export type SetupGuardDecision = 'allow' | 'redirect-workspace' | 'redirect-login'

/** 纯函数决策：allow 放行向导/提示页；已激活一律重定向。 */
export function decideSetupAccess(input: SetupGuardInput): SetupGuardDecision {
  if (!input.setupDone) {
    return 'allow'
  }
  return input.authenticated ? 'redirect-workspace' : 'redirect-login'
}
