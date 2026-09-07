// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { frameOriginFor } from './module-bridge'

const BASE = 'https://team.example.com'

describe('frameOriginFor（桥的 origin 校验输入）', () => {
  it('同域完整 URL → 实例 origin', () => {
    expect(frameOriginFor(`${BASE}/m/hello/`, BASE)).toBe(BASE)
  })

  it('相对路径 → 以 baseURL 解析', () => {
    expect(frameOriginFor('/m/hello/', BASE)).toBe(BASE)
  })

  it('第三方域名 → 其自身 origin（§5.3 逃生口）', () => {
    expect(frameOriginFor('https://chat.other.example/m/chat/', BASE)).toBe(
      'https://chat.other.example',
    )
  })

  it('坏值 → null', () => {
    expect(frameOriginFor(null, BASE)).toBeNull()
    expect(frameOriginFor('', BASE)).toBeNull()
    // 无 baseURL 且非浏览器环境（globalThis.location 缺失）
    const saved = globalThis.location
    delete (globalThis as { location?: unknown }).location
    expect(frameOriginFor('/m/hello/')).toBeNull()
    globalThis.location = saved
  })
})
