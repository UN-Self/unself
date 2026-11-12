// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { moduleFrameSrc, type RegistryModule } from './registry-api'

const BASE = 'https://team.example.com'

describe('moduleFrameSrc（iframe 装载地址解析；#349 U9 地址源 = 条目 entry 列）', () => {
  const mod = (entry: string | null): RegistryModule => ({
    id: 'hello',
    enabled: true,
    name: 'hello',
    entry,
    manifest: {
      id: 'hello',
      route: '/m/hello',
      runtimes: ['worker'],
      version: '1.0.0',
    },
  })

  it('条目 entry 同域完整 URL → 相对路径（单域名路径制 §5.3）', () => {
    expect(moduleFrameSrc(mod(`${BASE}/m/hello/`), BASE)).toBe('/m/hello/')
  })

  it('条目 entry 独立域名 → 绝对 URL（第三方逃生口 §5.3）', () => {
    expect(moduleFrameSrc(mod('https://chat.other.example/m/chat/'), BASE)).toBe(
      'https://chat.other.example/m/chat/',
    )
  })

  it('缺 entry → null（显示异常卡）', () => {
    expect(moduleFrameSrc(mod(null), BASE)).toBeNull()
  })

  it('纯路径 entry 视为同域相对路径（容错）', () => {
    expect(moduleFrameSrc(mod('/m/hello/'), BASE)).toBe('/m/hello/')
  })

  it('manifest 无地址字段也照常装载（#349 U9：manifest.entry 已移除，不回读清单）', () => {
    // 地址只在条目 entry 上；manifest 内没有 entry 键——moduleFrameSrc 不得读清单
    expect('entry' in (mod(`${BASE}/m/hello/`).manifest ?? {})).toBe(false)
    expect(moduleFrameSrc(mod(`${BASE}/m/hello/`), BASE)).toBe('/m/hello/')
  })

  it('真值面唯一：清单残留旧 entry 也不生效，装载只信条目 entry（U9 反漂移）', () => {
    // 存量行快照可能仍带旧 entry 键；两者不一致时必须用条目 entry（否则回到双源漂移）
    const stale = {
      ...mod('https://fresh.example.com/m/hello/'),
      manifest: { id: 'hello', route: '/m/hello', entry: '/stale/from-manifest/', runtimes: ['worker'], version: '1.0.0' },
    }
    expect(moduleFrameSrc(stale, BASE)).toBe('https://fresh.example.com/m/hello/')
  })
})
