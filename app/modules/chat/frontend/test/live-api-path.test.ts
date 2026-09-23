// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { liveApiBase, liveModuleMount } from '../src/lib/api'

describe('live chat API 挂载路径', () => {
  it('同域模块 iframe 保留 /m/<id> 前缀，避免请求落到 workbench', () => {
    expect(liveModuleMount('/m/chat/')).toBe('/m/chat')
    expect(liveApiBase('/m/chat/')).toBe('/m/chat/api')
  })

  it('workers.dev 根挂载不添加路径前缀', () => {
    expect(liveModuleMount('/')).toBe('')
    expect(liveApiBase('/')).toBe('/api')
  })

  it('只识别模块挂载段，不误判普通路径', () => {
    expect(liveModuleMount('/login')).toBe('')
    expect(liveModuleMount('/m/chatroom/')).toBe('/m/chatroom')
  })
})
