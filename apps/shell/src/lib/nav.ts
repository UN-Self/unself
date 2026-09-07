// SPDX-License-Identifier: AGPL-3.0-only

export interface ModuleMeta {
  id: string
  enabled: boolean
}

export interface NavItem {
  id: string
  label: string
}

/** 壳内固定导航项，永远排最前（对应“工作台”，非模块） */
const WORKSPACE_ITEM: NavItem = { id: '工作台', label: '工作台' }

/**
 * 由模块清单生成侧边栏导航：最前固定“工作台”，后接 enabled 模块项（label = id）。
 * 纯函数：只依赖入参；供 App.vue 使用并单元测试。
 */
export function buildNav(modules: ModuleMeta[]): NavItem[] {
  return [
    WORKSPACE_ITEM,
    ...modules.filter((m) => m.enabled).map((m) => ({ id: m.id, label: m.id })),
  ]
}
