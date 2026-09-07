// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { Inbox, Video } from 'lucide-vue-next'

import { moduleInitial, resolveModuleIcon } from './module-icon'

describe('模块图标解析（#12 白名单映射）', () => {
  it('白名单内映射到 Lucide 组件', () => {
    expect(resolveModuleIcon('inbox')).toBe(Inbox)
    expect(resolveModuleIcon('meet')).toBe(Video)
  })

  it('未知图标名回退 null（渲染层回退模块名首字）', () => {
    expect(resolveModuleIcon('nonexistent-icon')).toBeNull()
  })

  it('缺省 icon 回退 null', () => {
    expect(resolveModuleIcon(undefined)).toBeNull()
    expect(resolveModuleIcon(null)).toBeNull()
    expect(resolveModuleIcon('')).toBeNull()
  })
})

describe('模块名首字回退', () => {
  it('取首字并转大写', () => {
    expect(moduleInitial('hello')).toBe('H')
    expect(moduleInitial('chat')).toBe('C')
  })

  it('空 id 回退占位符（不会是 emoji）', () => {
    expect(moduleInitial('')).toBe('?')
  })
})
