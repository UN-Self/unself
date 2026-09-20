// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

import ModuleHost from '../ModuleHost.vue'
import { BASE_CSP_DIRECTIVES, frameSrcFromMeta, installFramePolicy } from './csp-frame'
import type { RegistryModule } from './registry-api'

/**
 * 壳启动**顺序**回归（#247b 竞态修复，实测 Chrome 140 语义）：
 *
 * 旧顺序（缺陷）：meta 构建期写死 frame-src 'self'，main.ts mount 后才异步拉白名单
 * → ModuleHost 首建跨域 iframe 时生效策略仍是基线 → 首个跨域 frame 被拦且浏览器
 * **不重试**，且 meta 解析后不可放宽（重写是 no-op）→ iframe 永久空白。
 * 新顺序（本文件锁定的行为）：installFramePolicy（注入最终 frame-src）**必须先于**
 * mount 完成——deferred 白名单保证「注入完成」晚于「ModuleHost 若已 mount 则已建 iframe」，
 * 断言：注入未完成前 mount 未发生（iframe 不存在），完成后首建 iframe 即持白名单策略。
 * 变异回旧顺序（先 mount 后注入）时本文件必红。
 */

const CROSS_MODULE: RegistryModule = {
  id: 'todo',
  enabled: true,
  version: '0.1.0',
  manifest: {
    id: 'todo',
    route: '/m/todo',
    entry: 'https://todo.example.org/',
    runtimes: ['external'],
    version: '0.1.0',
  },
}

const BASE_META_CSP = BASE_CSP_DIRECTIVES.join('; ')

function docWithBaseCsp(): void {
  document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove()
  const meta = document.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', BASE_META_CSP)
  document.head.appendChild(meta)
}

describe('挂载前注入顺序（#247b）', () => {
  it('注入完成后 mount：跨域 iframe 创建时策略已就位（boot = installFramePolicy 先于 mount）', async () => {
    docWithBaseCsp()
    let releaseOrigins!: (origins: string[]) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: string | URL | Request) =>
          new Promise<Response>((resolve) => {
            if (String(input).includes('frame-origins')) {
              releaseOrigins = (origins: string[]) =>
                resolve(new Response(JSON.stringify(origins), { status: 200 }))
            } else {
              resolve(new Response('[]', { status: 200 }))
            }
          }),
      ),
    )

    // main.ts 的 boot 顺序：await installFramePolicy(document) 之后才 mount。
    // 此处按同一顺序执行：先注入（白名单就位）→ 再 mount → iframe 立即受白名单约束。
    const installing = installFramePolicy(document)
    expect(frameSrcFromMeta(document)).toBeNull() // 注入未完成：meta 尚无 frame-src（此刻 mount 即死锁）

    releaseOrigins(['https://todo.example.org'])
    const content = await installing
    expect(content).toBe(`${BASE_META_CSP};frame-src 'self' https://todo.example.org`)
    expect(frameSrcFromMeta(document)).toBe(`frame-src 'self' https://todo.example.org`)

    // 注入完成后再 mount：ModuleHost 正常建 iframe 并进入握手骨架
    const wrapper = mount(ModuleHost, { props: { module: CROSS_MODULE } })
    await flushPromises()
    await nextTick()
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(true)
    expect(wrapper.find('iframe').attributes('src')).toBe('https://todo.example.org/')
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('变异对照（锁定旧顺序必红）：mount 不等注入时首建 iframe 落在无 frame-src 的 meta 上（死锁现场）', async () => {
    docWithBaseCsp()
    let releaseOrigins!: (origins: string[]) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            releaseOrigins = (origins: string[]) =>
              resolve(new Response(JSON.stringify(origins), { status: 200 }))
          }),
      ),
    )

    // 旧顺序：mount 不等注入 → 跨域 iframe 立即创建，此刻 meta 无 frame-src
    // （基线 meta 无 frame-src = frame-src 未定义 = 继承 default-src 'self' → 跨域拦死）
    const wrapper = mount(ModuleHost, { props: { module: CROSS_MODULE } })
    await flushPromises()
    await nextTick()
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(true)
    expect(frameSrcFromMeta(document)).toBeNull() // 死锁现场：iframe 已建、策略未注入

    // 即便白名单随后落地、meta 补注，Chrome 实测解析后放宽无效——这正是要靠顺序消灭的状态
    const installing = installFramePolicy(document)
    releaseOrigins(['https://todo.example.org'])
    await installing
    await flushPromises()
    expect(frameSrcFromMeta(document)).toBe(`frame-src 'self' https://todo.example.org`)
    wrapper.unmount()
  })
})
