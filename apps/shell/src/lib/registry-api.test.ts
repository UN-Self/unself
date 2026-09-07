// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { moduleFrameSrc, type RegistryModule } from './registry-api'

const BASE = 'https://team.example.com'

describe('moduleFrameSrc（iframe 装载地址解析）', () => {
  const mod = (entry: string): RegistryModule => ({
    id: 'hello',
    enabled: true,
    version: '1.0.0',
    manifest: {
      id: 'hello',
      route: '/m/hello',
      entry,
      runtime: 'worker',
      version: '1.0.0',
    },
  })

  it('同域完整 URL → 相对路径（单域名路径制 §5.3）', () => {
    expect(moduleFrameSrc(mod(`${BASE}/m/hello/`), BASE)).toBe('/m/hello/')
  })

  it('独立域名 entry → 绝对 URL（第三方逃生口 §5.3）', () => {
    expect(moduleFrameSrc(mod('https://chat.other.example/m/chat/'), BASE)).toBe(
      'https://chat.other.example/m/chat/',
    )
  })

  it('缺 entry → null（显示异常卡）', () => {
    const noEntry = { ...mod(`${BASE}/m/hello/`), manifest: null }
    expect(moduleFrameSrc(noEntry, BASE)).toBeNull()
  })

  it('纯路径 entry 视为同域相对路径（contracts z.url() 允许绝对 URL，此为容错）', () => {
    expect(moduleFrameSrc(mod('/m/hello/'), BASE)).toBe('/m/hello/')
  })
})
