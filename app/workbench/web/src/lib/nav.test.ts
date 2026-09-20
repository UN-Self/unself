// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { buildNav, isHostView } from './nav'

describe('buildNav（#12 双形态共用数据源）', () => {
  it('过滤 disabled 模块（停用 = 从侧栏消失）', () => {
    const nav = buildNav([
      { id: 'hello', enabled: true },
      { id: 'chat', enabled: false },
    ])
    expect(nav.map((n) => n.id)).toEqual(['workspace', 'hello'])
  })

  it('保持 enabled 模块的传入顺序', () => {
    const nav = buildNav([
      { id: 'b', enabled: true },
      { id: 'a', enabled: true },
    ])
    expect(nav.map((n) => n.id)).toEqual(['workspace', 'b', 'a'])
  })

  it('固定项「工作台」始终在第一位（workspace id）', () => {
    const nav = buildNav([])
    expect(nav[0]).toEqual({ id: 'workspace', label: '工作台' })
  })

  it('icon 字段透传（manifest icon → 渲染器白名单映射）', () => {
    const nav = buildNav([{ id: 'hello', enabled: true, icon: 'inbox' }])
    expect(nav[1]).toEqual({ id: 'hello', label: 'hello', icon: 'inbox' })
  })
})

describe('isHostView', () => {
  it('只有 workspace 是壳内视图', () => {
    expect(isHostView('workspace')).toBe(true)
    expect(isHostView('hello')).toBe(false)
  })
})
