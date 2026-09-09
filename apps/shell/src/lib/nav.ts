// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 边栏/标签栏导航数据（#12，§6.5 双形态）：
 * 同一份 nav 数据、两个渲染器（桌面左栏 / 窄屏底部标签栏）。
 * 纯函数：只依赖入参，不触 DOM/网络。
 */

export interface ModuleMeta {
  id: string
  enabled: boolean
  /** manifest icon 字段（Lucide 图标名，#1 契约；缺省/未知回退首字）。 */
  icon?: string
}

export interface NavItem {
  /** 路由标识：'workspace' 为壳内工作台，其余为模块 id（/m/<id>/ 装载）。 */
  id: string
  label: string
  icon?: string
}

/** 壳内固定导航项，永远排最前（对应「工作台」，非模块）。 */
const WORKSPACE_ITEM: NavItem = { id: 'workspace', label: '工作台' }

/**
 * 由注册表模块清单生成导航数据：最前固定「工作台」，后接 enabled 模块项。
 * 停用模块 = 从数据源消失（成员视角，§5.5 启停语义）。
 */
export function buildNav(modules: ModuleMeta[]): NavItem[] {
  return [
    WORKSPACE_ITEM,
    ...modules
      .filter((m) => m.enabled)
      .map((m) => ({ id: m.id, label: m.id, icon: m.icon })),
  ]
}

/** nav 项是否为壳内固定视图（工作台/空态），不装载 iframe。 */
export function isHostView(navId: string): boolean {
  return navId === 'workspace'
}
