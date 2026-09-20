// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 登录后落地规则（#11，§6.5 动线）：
 * - 从模块处跳转登录（next=/m/<id>/…）→ 回到该模块
 * - 直访 / → 落第一个启用模块；没有启用模块 → 落空态（工作台）
 */

/** 解析 next：仅接受本站绝对路径，防开放重定向。 */
export function sanitizeNext(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//')) {
    return null
  }
  return next
}

export interface LandingTarget {
  /** 登录后应到达的站内路径。 */
  path: string
}

/** 有 next 且合法：回原目标。 */
export function landingFromNext(next: string | null | undefined): LandingTarget | null {
  const safe = sanitizeNext(next)
  return safe ? { path: safe } : null
}

/** 直访：落第一个启用模块；全停用落工作台空态。 */
export function landingDefault(enabledModuleIds: string[]): LandingTarget {
  const first = enabledModuleIds[0]
  return { path: first ? `/m/${first}/` : '/' }
}

/** 组合落地规则：next 优先，默认次之。 */
export function resolveLanding(
  next: string | null | undefined,
  enabledModuleIds: string[],
): LandingTarget {
  return landingFromNext(next) ?? landingDefault(enabledModuleIds)
}
