// SPDX-License-Identifier: AGPL-3.0-only
import { computed, inject, onBeforeUnmount, ref, watch, type InjectionKey } from 'vue'
import type { Attachment } from './types'
export type AttachmentLoader = (url: string, signal: AbortSignal) => Promise<Blob>
export const attachmentLoaderKey: InjectionKey<AttachmentLoader> = Symbol('attachment-loader')
/** Only send module credentials to this module's own file endpoint. */
export function createAttachmentLoader(getToken: () => string | null, fetcher: typeof fetch = fetch): AttachmentLoader {
  return async (path, signal) => {
    const url = new URL(path, location.href)
    const prefix = location.pathname.startsWith('/m/chat/') ? '/m/chat/files/' : '/files/'
    if (url.origin !== location.origin || !url.pathname.startsWith(prefix)) throw new Error('无效的附件地址')
    const token = getToken()
    if (!token) throw new Error('登录已过期')
    const response = await fetcher(url.href, { headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error' })
    if (!response.ok) throw new Error('附件读取失败')
    return response.blob()
  }
}
/** One in-flight read and one object URL per mounted message; never persist private media. */
export function useAttachmentResource(attachment: () => Attachment | null) {
  const loader = inject(attachmentLoaderKey, null)
  const objectUrl = ref('')
  const failed = ref(false)
  const loading = ref(false)
  let controller: AbortController | null = null
  let pending: Promise<string> | null = null
  const source = computed(() => loader ? objectUrl.value : attachment()?.url ?? '')
  function reset() {
    controller?.abort(); controller = null; pending = null
    if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
    objectUrl.value = ''; failed.value = false; loading.value = false
  }
  async function load(): Promise<string> {
    if (source.value) return source.value
    if (pending) return pending
    const file = attachment()
    if (!file || !loader) return ''
    const request = new AbortController()
    controller = request; loading.value = true; failed.value = false
    pending = loader(file.url, request.signal).then((blob) => {
      if (request.signal.aborted) return ''
      objectUrl.value = URL.createObjectURL(blob)
      return objectUrl.value
    }).catch(() => {
      if (!request.signal.aborted) failed.value = true
      return ''
    }).finally(() => {
      if (controller === request) { loading.value = false; pending = null }
    })
    return pending
  }
  async function download() {
    const file = attachment()
    const url = await load()
    if (!url || !file || attachment() !== file) return
    const link = document.createElement('a')
    link.href = url; link.download = file.name; link.rel = 'noopener'; link.target = '_blank'
    document.body.append(link); link.click(); link.remove()
  }
  watch(() => attachment()?.url, reset, { flush: 'sync' })
  onBeforeUnmount(reset)
  return { source, failed, loading, load, download }
}
export type AttachmentResource = ReturnType<typeof useAttachmentResource>
export const attachmentResourceKey: InjectionKey<AttachmentResource> = Symbol('attachment-resource')
