// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'

import { liveApiBase, liveModuleMount, moduleFileUrl } from '../src/lib/api'

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

  it('Worker 返回的文件路径在壳挂载下补齐模块前缀，根部署保持原路径', () => {
    expect(moduleFileUrl('/m/chat/', '/files/u/voice.webm')).toBe('/m/chat/files/u/voice.webm')
    expect(moduleFileUrl('/', '/files/u/voice.webm')).toBe('/files/u/voice.webm')
    expect(moduleFileUrl('/m/chat/', 'https://cdn.example/file')).toBe('https://cdn.example/file')
  })
})
