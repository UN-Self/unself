// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import SettingsView from './SettingsView.vue'

async function setup(authenticated = true) {
  const user = { id: 'u1', name: '旧名字', avatarUrl: '', issuer: 'builtin', sub: 'u1', role: 'user' }
  let fail = false
  const writes: Array<{ path: string; method: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (!authenticated) return Response.json({ error: '请登录' }, { status: 401 })
    if (method !== 'GET') {
      writes.push({ path, method, body: init?.body })
      if (fail) return Response.json({ error: '保存失败，请重试' }, { status: 503 })
      if (method === 'PATCH') { user.name = JSON.parse(init!.body as string).name; return Response.json({ name: user.name }) }
      user.avatarUrl = method === 'PUT' ? 'https://team.example/api/avatars/test.png' : ''
      return Response.json({ avatarUrl: user.avatarUrl })
    }
    return Response.json({ authenticated: true, user, mailEnabled: true, avatarUploadEnabled: true })
  }))
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/settings', component: SettingsView },
    { path: '/login', component: { template: '<div />' } },
    { path: '/', component: { template: '<div />' } },
    { path: '/app-password', component: { template: '<div />' } },
  ] })
  await router.push('/settings')
  await router.isReady()
  const wrapper = mount(SettingsView, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router, writes, failSave: () => { fail = true } }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('成员个人设置', () => {
  it('保存昵称、上传及移除头像都走 Core，保存结果可见', async () => {
    const { wrapper, writes } = await setup()
    await wrapper.find('input[name="display-name"]').setValue('新名字')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(writes[0]).toMatchObject({ path: '/api/me', method: 'PATCH', body: JSON.stringify({ name: '新名字' }) })
    expect(wrapper.find('[role="status"]').text()).toBe('昵称已保存')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
    const file = new File(['image'], 'avatar.png', { type: 'image/png' })
    const input = wrapper.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
    await flushPromises()
    expect(writes[1]).toMatchObject({ path: '/api/me/avatar', method: 'PUT', body: file })
    expect(wrapper.find('img').attributes('src')).toBe('https://team.example/api/avatars/test.png')
    await wrapper.findAll('button').find(b => b.text() === '移除')!.trigger('click')
    await flushPromises()
    expect(writes[2]).toMatchObject({ path: '/api/me/avatar', method: 'DELETE' })
    expect(wrapper.find('img').exists()).toBe(false)
    wrapper.unmount()
  })
  it('失败时保留输入并允许重试，未登录直接访问设置转到登录页', async () => {
    const { wrapper, failSave } = await setup()
    failSave()
    await wrapper.find('input[name="display-name"]').setValue('未保存')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('保存失败')
    expect((wrapper.find('input[name="display-name"]').element as HTMLInputElement).value).toBe('未保存')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
    const anonymous = await setup(false)
    expect(anonymous.router.currentRoute.value.path).toBe('/login')
    expect(anonymous.router.currentRoute.value.query.next).toBe('/settings')
    anonymous.wrapper.unmount()
  })
})
