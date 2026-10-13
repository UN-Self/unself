// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import MessageBubble from '../src/components/MessageBubble.vue'
import { attachmentLoaderKey } from '../src/lib/attachment-resource'
import type { Message } from '../src/lib/types'
const message = (over: Partial<Message> = {}): Message => ({
  id: 11, content: '可复制的消息', mentionUserIds: [], mentions: [], createdAt: '2026-10-13T09:00:00Z', source: 'local',
  sender: { kind: 'local', id: 1, username: 'alice', displayName: 'Alice', avatarUrl: '', source: 'local' },
  attachment: null, ...over,
})
const file = (type = 'image/png') => ({ key: 'pic', name: '样例.png', type, size: 1024, url: '/m/chat/files/pic' })
const wrappers: ReturnType<typeof mount>[] = []
function render(over: Partial<Message> = {}, canDelete = true) {
  const wrapper = mount(MessageBubble, { attachTo: document.body, props: { message: message(over), mine: true, canDelete } })
  wrappers.push(wrapper)
  return wrapper
}
async function settle() { await flushPromises(); await new Promise((resolve) => setTimeout(resolve, 30)); await flushPromises() }
function item(label: string) { return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes(label)) }
afterEach(() => { wrappers.splice(0).forEach((w) => w.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('消息媒体与菜单交互', () => {
  it('图片直接加载模块路径，点击放大，关闭恢复焦点', async () => {
    const wrapper = render({ attachment: file() })
    const button = wrapper.get('button[aria-label="预览图片：样例.png"]')
    expect(button.get('img').attributes('src')).toBe('/m/chat/files/pic')
    ;(button.element as HTMLElement).focus()
    await button.trigger('click'); await settle()
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('/m/chat/files/pic')
    document.querySelector<HTMLButtonElement>('[aria-label="关闭图片预览"]')!.click()
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(button.element)
  })
  it('图片失败回退下载，撤回时连同打开的预览一起清除', async () => {
    const wrapper = render({ attachment: file() })
    await wrapper.get('img[alt="样例.png"]').trigger('error')
    expect(wrapper.get('a[download]').attributes('href')).toBe('/m/chat/files/pic')
    expect(wrapper.find('button[aria-label^="预览图片"]').exists()).toBe(false)
    await wrapper.setProps({ message: message({ attachment: { ...file(), key: 'new', url: '/m/chat/files/new' } }) })
    await wrapper.get('button[aria-label^="预览图片"]').trigger('click'); await settle()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await wrapper.setProps({ message: message({ deleted: true, attachment: file() }) }); await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(wrapper.find('img[alt="样例.png"]').exists()).toBe(false)
    expect(wrapper.find('a[download]').exists()).toBe(false)
  })
  it.each([['video/mp4', 'video'], ['audio/mpeg', 'audio']])('%s 有控件且不自动加载内容，失败可下载', async (type, tag) => {
    const wrapper = render({ attachment: file(type) })
    const media = wrapper.get(tag)
    expect(media.attributes('src')).toBe('/m/chat/files/pic')
    expect(media.attributes('controls')).toBeDefined()
    expect(media.attributes('autoplay')).toBeUndefined()
    expect(media.attributes('preload')).toBe('none')
    await media.trigger('error')
    expect(wrapper.find(tag).exists()).toBe(false)
    expect(wrapper.get('a[download]').attributes('href')).toBe('/m/chat/files/pic')
  })
  it('右键后复制文本写入剪贴板，菜单消失；失败明确提示', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText } }))
    const wrapper = render()
    expect(document.querySelector('[role="menuitem"]')).toBeNull()
    await wrapper.get('[aria-haspopup="menu"]').trigger('contextmenu', { clientX: 20, clientY: 20 }); await settle()
    item('复制文本')!.click(); await settle()
    expect(writeText).toHaveBeenCalledWith('可复制的消息')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(wrapper.get('[role="status"]').text()).toBe('已复制')
    writeText.mockRejectedValueOnce(new Error('denied'))
    await wrapper.get('[aria-haspopup="menu"]').trigger('contextmenu'); await settle()
    item('复制文本')!.click(); await settle()
    expect(wrapper.get('[role="status"]').text()).toContain('复制失败')
    vi.unstubAllGlobals()
  })
  it('撤回只有在菜单中选择后触发；无权限不出现撤回项', async () => {
    const wrapper = render()
    expect(wrapper.find('[data-test="message-delete"]').exists()).toBe(false)
    await wrapper.get('[aria-haspopup="menu"]').trigger('keydown', { key: 'F10', shiftKey: true }); await settle()
    expect(wrapper.emitted('delete')).toBeUndefined()
    item('撤回')!.click(); await settle()
    expect(wrapper.emitted('delete')).toEqual([[message()]])
    await wrapper.setProps({ canDelete: false })
    await wrapper.get('[aria-haspopup="menu"]').trigger('contextmenu'); await settle()
    expect(item('撤回')).toBeUndefined()
    expect(item('复制文本')).toBeDefined()
    await wrapper.setProps({ message: message({ deleted: true }) }); await settle()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
  it('下载附件通过认证资源生成下载地址；长按后可以关闭菜单', async () => {
    const loader = vi.fn().mockResolvedValue(new Blob(['private']))
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:download') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const clicked: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.href) })
    const wrapper = mount(MessageBubble, { attachTo: document.body, props: { message: message({ attachment: file('application/pdf') }), mine: true }, global: { provide: { [attachmentLoaderKey as symbol]: loader } } })
    wrappers.push(wrapper)
    const trigger = wrapper.get('[aria-haspopup="menu"]')
    trigger.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 10, clientY: 10 }))
    await new Promise(resolve => setTimeout(resolve, 800)); await settle()
    item('下载附件')!.click(); await settle()
    expect(loader).toHaveBeenCalledWith('/m/chat/files/pic', expect.any(AbortSignal))
    expect(clicked).toEqual(['blob:download'])
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
  it('菜单可以预览图片、下载附件，Esc 关闭后恢复焦点', async () => {
    const wrapper = render({ content: '', attachment: file() })
    const trigger = wrapper.get('[aria-haspopup="menu"]')
    await trigger.trigger('contextmenu'); await settle()
    expect(item('复制文本')).toBeUndefined()
    expect(item('下载附件')).toBeDefined()
    item('预览图片')!.click(); await settle()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await trigger.trigger('contextmenu'); await settle()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
  })
})
