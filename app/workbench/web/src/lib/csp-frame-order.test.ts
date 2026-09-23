// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

import { boot } from '../main'
import { router } from '../router'
import { BASE_CSP_DIRECTIVES, frameSrcFromMeta } from './csp-frame'
import type { RegistryModule } from './registry-api'

/**
 * 壳启动**顺序**回归（#247b 竞态修复；#265 改测真实 boot 路径）。
 *
 * 缺陷语义（有头 Chrome 140 实测）：meta CSP 与响应头取交集，且文档解析后 meta 不可放宽
 * ——构建期写死 frame-src 'self' + 运行期收紧对跨域 iframe 是死锁。唯一正确顺序 =
 * **挂载前** await installFramePolicy 注入最终 frame-src，之后才 mount。
 *
 * 本文件直接调用 `main.ts` 的 `boot()`（生产引导路径本体），注入 deferred 的
 * `/api/modules/frame-origins`：白名单未 resolve 前 boot 不得 mount（#app 空、无 iframe）；
 * resolve 后 mount 才发生，且首建 iframe 已持白名单策略。
 * 把 boot 里的 `await installFramePolicy` 改成 fire-and-forget（恢复缺陷顺序）→ 本文件必红。
 */

const CROSS_MODULE: RegistryModule = {
  id: 'todo',
  enabled: true,
  version: '0.1.0',
  manifest: {
    id: 'todo',
    route: '/m/todo/',
    entry: 'https://todo.example.org/',
    runtimes: ['external'],
    version: '0.1.0',
  },
}

const BASE_META_CSP = BASE_CSP_DIRECTIVES.join('; ')

/** 装 index.html 的挂载点与构建期注入的 CSP meta 占位（无 frame-src）。 */
function pageFixture(): void {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  const meta = document.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', BASE_META_CSP)
  document.head.appendChild(meta)
  const app = document.createElement('div')
  app.id = 'app'
  document.body.appendChild(app)
}

/** boot 需要知道的挂载点存在与否（mount 是否真的发生）。 */
function appMountPoint(): HTMLElement {
  return document.getElementById('app') as HTMLElement
}

/** 白名单 deferred：由用例在需要时放行。 */
function deferredOrigins(): { release: (origins: string[]) => void } {
  let release!: (origins: string[]) => void
  const gate = new Promise<Response>((resolve) => {
    release = (origins) => resolve(new Response(JSON.stringify(origins), { status: 200 }))
  })
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('frame-origins')) return gate
      if (url.includes('/api/me')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              authenticated: true,
              user: { id: 'u1', name: '管理员', issuer: 'unself', sub: 'u1' },
              mailEnabled: false,
              mailPortalUrl: null,
            }),
            { status: 200 },
          ),
        )
      }
      if (url.includes('/api/modules')) {
        return Promise.resolve(new Response(JSON.stringify([CROSS_MODULE]), { status: 200 }))
      }
      return Promise.resolve(new Response('null', { status: 200 }))
    }),
  )
  return { release }
}

/** 冲刷整条异步链（白名单 → mount → 会话 → 注册表 → 落地 → 挂桥）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await flushPromises()
    await nextTick()
  }
}

beforeEach(async () => {
  pageFixture()
  await router.replace('/')
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('壳启动顺序：注入先于 mount（#247b；#265 直测真 boot）', () => {
  it('白名单未 resolve 前 boot 不 mount（#app 空、无 iframe）；resolve 后才 mount 且首建 iframe 持白名单', async () => {
    const origins = deferredOrigins()

    const booting = boot()

    // 白名单往返尚未完成：boot 卡在 await，mount 不得发生
    await settle()
    expect(appMountPoint().childElementCount).toBe(0)
    expect(document.querySelector('iframe')).toBeNull()
    // 策略也未就位——此刻若 mount 就是缺陷现场（跨域 iframe 会被基线拦死）
    expect(frameSrcFromMeta(document)).toBeNull()

    // 白名单到达 → boot 继续 → mount → 壳渲染 → 落地跨域模块 → 首建 iframe
    origins.release(['https://todo.example.org'])
    await booting
    await settle()

    expect(frameSrcFromMeta(document)).toBe(`frame-src 'self' https://todo.example.org`)
    const iframe = document.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('src')).toBe('https://todo.example.org/')
    expect(document.querySelector('.shell')).not.toBeNull()
  })

  it('白名单失败（网络异常）→ fail-closed 注入 self 基线，且 mount 照常发生（不白屏）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url = String(input)
        if (url.includes('frame-origins')) return Promise.reject(new Error('network down'))
        if (url.includes('/api/me')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                authenticated: true,
                user: { id: 'u1', name: '管理员', issuer: 'unself', sub: 'u1' },
                mailEnabled: false,
                mailPortalUrl: null,
              }),
              { status: 200 },
            ),
          )
        }
        if (url.includes('/api/modules')) {
          return Promise.resolve(new Response(JSON.stringify([CROSS_MODULE]), { status: 200 }))
        }
        return Promise.resolve(new Response('null', { status: 200 }))
      }),
    )

    await boot()
    await settle()

    // fail-closed：策略收窄为 'self'（绝不放宽），页面照常挂载
    expect(frameSrcFromMeta(document)).toBe(`frame-src 'self'`)
    expect(document.querySelector('.shell')).not.toBeNull()
  })
})
