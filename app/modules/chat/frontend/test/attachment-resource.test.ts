// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { attachmentLoaderKey, createAttachmentLoader, useAttachmentResource } from '../src/lib/attachment-resource'
const file = { key: 'k', name: 'private.png', type: 'image/png', size: 10, url: '/files/private' }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('认证附件读取与生命周期', () => {
  it('读取时使用最新 token，不把 token 放进 URL；拒绝外部地址或非文件路径', async () => {
    let token = 'first'
    const fetcher = vi.fn().mockResolvedValue(new Response('image', { status: 200 }))
    const load = createAttachmentLoader(() => token, fetcher)
    const signal = new AbortController().signal
    await load(file.url, signal)
    token = 'renewed'
    fetcher.mockResolvedValueOnce(new Response('image'))
    await load(file.url, signal)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: 'Bearer first' }, signal, redirect: 'error' })
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: { Authorization: 'Bearer renewed' } })
    expect(fetcher.mock.calls[0]?.[0]).toBe(new URL(file.url, location.href).href)
    await expect(load('https://outside.example/files/private', signal)).rejects.toThrow()
    await expect(load('/api/me', signal)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('读取失败不缓存，下一次允许重试', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 403 }))
    const load = createAttachmentLoader(() => 'token', fetcher)
    await expect(load(file.url, new AbortController().signal)).rejects.toThrow('附件读取失败')
    fetcher.mockResolvedValue(new Response('valid'))
    expect(await load(file.url, new AbortController().signal)).toBeInstanceOf(Blob)
  })
  it('并发预览复用一次网络读取，撤回中止读取并释放已下载数据', async () => {
    let resolve!: (blob: Blob) => void
    let signal!: AbortSignal
    const loader = vi.fn((_url: string, s: AbortSignal) => { signal = s; return new Promise<Blob>((done) => { resolve = done }) })
    const create = vi.fn(() => 'blob:private')
    const revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
    let resource!: ReturnType<typeof useAttachmentResource>
    const Harness = defineComponent({ props: { deleted: Boolean }, setup(props) { resource = useAttachmentResource(() => props.deleted ? null : file); return () => null } })
    const wrapper = mount(Harness, { global: { provide: { [attachmentLoaderKey as symbol]: loader } } })
    try {
      const first = resource.load(); const second = resource.load()
      expect(loader).toHaveBeenCalledTimes(1)
      resolve(new Blob(['image'])); await Promise.all([first, second]); await flushPromises()
      expect(resource.source.value).toBe('blob:private')
      await resource.load(); expect(loader).toHaveBeenCalledTimes(1)
      await wrapper.setProps({ deleted: true })
      expect(revoke).toHaveBeenCalledWith('blob:private')
      expect(resource.source.value).toBe('')
      await wrapper.setProps({ deleted: false })
      const pending = resource.load()
      wrapper.unmount()
      expect(signal.aborted).toBe(true)
      resolve(new Blob(['late'])); await pending
      expect(create).toHaveBeenCalledTimes(1)
    } finally { wrapper.unmount() }
  })
})
