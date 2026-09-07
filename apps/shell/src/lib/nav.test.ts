// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildNav } from './nav'

describe('buildNav', () => {
  it('过滤 disabled 模块', () => {
    const nav = buildNav([
      { id: 'Hello', enabled: true },
      { id: 'Secret', enabled: false },
    ])
    expect(nav.map((n) => n.id)).toEqual(['工作台', 'Hello'])
  })

  it('保持 enabled 模块的传入顺序', () => {
    const nav = buildNav([
      { id: 'B', enabled: true },
      { id: 'A', enabled: true },
    ])
    expect(nav.map((n) => n.id)).toEqual(['工作台', 'B', 'A'])
  })

  it('固定项“工作台”始终在第一位', () => {
    const nav = buildNav([])
    expect(nav[0]).toEqual({ id: '工作台', label: '工作台' })
  })
})
