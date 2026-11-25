// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 组件行为用例：只验「点了会怎样」，不锁样式与文案细节。
 * 编辑器（CodeMirror）不在 jsdom 里挂——它的行为由 lib 层用例覆盖，
 * 真机验证走浏览器（D6 取证那条线）。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import CommentPanel from '../src/components/CommentPanel.vue'
import ConflictDialog from '../src/components/ConflictDialog.vue'
import { createMockCommentsApi, type DocComment } from '../src/lib/docs-api-mock'
import type { Doc } from '../src/lib/docs-types'

function makeDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    id: 'doc_1',
    title: '标题',
    content: '服务端正文',
    ownerId: 'u_1',
    version: 9,
    createdAt: '2026-11-17T10:00:00.000Z',
    updatedAt: '2026-11-17T11:00:00.000Z',
    role: 'owner',
    ...overrides,
  }
}

function mountDialog(current: Doc | null = makeDoc()) {
  return mount(ConflictDialog, {
    props: { open: true, current, localChars: 12, charDelta: -3, titleChanged: false },
  })
}

describe('冲突对话框', () => {
  it('cover：点「用我的版本」直接发出 overwrite', async () => {
    const wrapper = mountDialog()
    await wrapper.get('[data-test="conflict-overwrite"]').trigger('click')
    expect(wrapper.emitted('choose')?.[0]).toEqual(['overwrite'])
  })

  it('点「载入服务端」第一次不生效，只切成确认态', async () => {
    const wrapper = mountDialog()
    const button = wrapper.get('[data-test="conflict-reload"]')
    await button.trigger('click')

    expect(wrapper.emitted('choose')).toBeUndefined()
    expect(button.text()).toContain('确认丢弃')
  })

  it('确认态再点一次才真的 reload', async () => {
    const wrapper = mountDialog()
    const button = wrapper.get('[data-test="conflict-reload"]')
    await button.trigger('click')
    await button.trigger('click')
    expect(wrapper.emitted('choose')?.[0]).toEqual(['reload'])
  })

  it('取消直接发出 cancel（本地内容不动）', async () => {
    const wrapper = mountDialog()
    await wrapper.get('[data-test="conflict-cancel"]').trigger('click')
    expect(wrapper.emitted('choose')?.[0]).toEqual(['cancel'])
  })

  it('展示服务端版本号与摘要', () => {
    const wrapper = mountDialog()
    expect(wrapper.text()).toContain('v9')
    expect(wrapper.text()).toContain('服务端正文')
  })

  it('关闭时整块不渲染', () => {
    const wrapper = mount(ConflictDialog, {
      props: { open: false, current: null, localChars: 0, charDelta: 0, titleChanged: false },
    })
    expect(wrapper.find('[data-test="conflict-dialog"]').exists()).toBe(false)
  })
})

function makeComment(overrides: Partial<DocComment> = {}): DocComment {
  return {
    id: 'c_1',
    docId: 'doc_1',
    authorId: 'u_1',
    authorName: '某人',
    body: '这条评论的内容',
    createdAt: '2026-11-18T01:00:00.000Z',
    deletedAt: null,
    ...overrides,
  }
}

function mountComments(options: {
  seed?: DocComment[]
  meId?: string
  quote?: string | null
} = {}) {
  const api = createMockCommentsApi(options.seed ?? [])
  const wrapper = mount(CommentPanel, {
    props: {
      docId: 'doc_1',
      api,
      meId: options.meId ?? 'u_1',
      quote: options.quote ?? null,
    },
  })
  return { wrapper, api }
}

describe('评论面板（D10）', () => {
  it('挂载后加载列表，发表后追加', async () => {
    const { wrapper } = mountComments()
    await flushPromises()
    expect(wrapper.text()).toContain('还没有评论')

    await wrapper.get('[data-test="comment-input"]').setValue('第一行意见')
    await wrapper.get('[data-test="comment-submit"]').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('第一行意见')
    const input = wrapper.get('[data-test="comment-input"]').element as HTMLTextAreaElement
    expect(input.value).toBe('')
  })

  it('空白内容不发请求', async () => {
    const { wrapper } = mountComments()
    await flushPromises()
    await wrapper.get('[data-test="comment-input"]').setValue('   ')
    expect(wrapper.get('[data-test="comment-submit"]').attributes('disabled')).toBeDefined()
  })

  it('删除按钮只出现在自己的评论上（别人的没有）', async () => {
    const { wrapper } = mountComments({
      seed: [makeComment({ id: 'mine', authorId: 'u_1' }), makeComment({ id: 'theirs', authorId: 'u_2', authorName: '别人' })],
      meId: 'u_1',
    })
    await flushPromises()

    expect(wrapper.find('[data-test="comment-delete-mine"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="comment-delete-theirs"]').exists()).toBe(false)
  })

  it('删除是软删：占位文案出现，行不消失，按钮不再出现', async () => {
    const { wrapper } = mountComments({ seed: [makeComment({ id: 'mine' })], meId: 'u_1' })
    await flushPromises()

    await wrapper.get('[data-test="comment-delete-mine"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="comment-tombstone"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('该评论已删除')
    expect(wrapper.find('[data-test="comment-delete-mine"]').exists()).toBe(false)
  })

  it('引用所选：带引用发表，正文里带引用行，发表后清掉引用', async () => {
    const { wrapper, api } = mountComments({ quote: '这段话有问题' })
    await flushPromises()

    expect(wrapper.find('[data-test="comment-quote"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('这段话有问题')

    await wrapper.get('[data-test="comment-input"]').setValue('改成这样吧')
    await wrapper.get('[data-test="comment-submit"]').trigger('submit')
    await flushPromises()

    const list = await api.listComments('doc_1')
    expect(list[0]!.body).toContain('> 这段话有问题')
    expect(list[0]!.body).toContain('改成这样吧')
    expect(wrapper.emitted('clear')).toHaveLength(1)

    // 父组件消费 clear 事件把引用清掉之后，引用框消失
    await wrapper.setProps({ quote: null })
    expect(wrapper.find('[data-test="comment-quote"]').exists()).toBe(false)
  })

  it('引用框可以手动移除', async () => {
    const { wrapper } = mountComments({ quote: '不要引用了' })
    await flushPromises()

    await wrapper.get('[aria-label="移除引用"]').trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })

  it('没有引用时不渲染引用框', async () => {
    const { wrapper } = mountComments()
    await flushPromises()
    expect(wrapper.find('[data-test="comment-quote"]').exists()).toBe(false)
  })
})
