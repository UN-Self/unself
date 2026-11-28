// SPDX-License-Identifier: AGPL-3.0-only

/**
 * D9 状态机用例：测行为，不测实现（docs/testing.md 的口径）。
 * 每条都对应验收表里的一句话，改坏必然变红。
 */
import { describe, expect, it } from 'vitest'

import {
  applyConflict,
  applyError,
  applySaved,
  beginSave,
  canEdit,
  canSave,
  createEditorState,
  draftDelta,
  editDraft,
  isDirty,
  resolveConflict,
  shouldWarnBeforeLeave,
} from '../src/lib/docs-editor-state'
import type { Doc, DocRole } from '../src/lib/docs-types'

function makeDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    id: 'doc_1',
    title: '标题',
    content: '正文',
    ownerId: 'u_1',
    version: 3,
    createdAt: '2026-11-17T10:00:00.000Z',
    updatedAt: '2026-11-17T10:00:00.000Z',
    role: 'owner',
    ...overrides,
  }
}

function asRole(role: DocRole): Doc {
  return makeDoc({ role })
}

describe('初始状态', () => {
  it('刚打开不脏、不能保存', () => {
    const state = createEditorState(makeDoc())
    expect(state.status).toBe('idle')
    expect(isDirty(state)).toBe(false)
    expect(canSave(state)).toBe(false)
  })

  it('草稿就是文档内容', () => {
    const state = createEditorState(makeDoc())
    expect(state.draft).toEqual({ title: '标题', content: '正文' })
  })
})

describe('编辑', () => {
  it('改正文变脏且可保存', () => {
    const state = editDraft(createEditorState(makeDoc()), { content: '正文 + 补充' })
    expect(state.status).toBe('dirty')
    expect(isDirty(state)).toBe(true)
    expect(canSave(state)).toBe(true)
  })

  it('改回原样自动回到 idle', () => {
    const edited = editDraft(createEditorState(makeDoc()), { content: '正文 + 补充' })
    const reverted = editDraft(edited, { content: '正文' })
    expect(reverted.status).toBe('idle')
    expect(canSave(reverted)).toBe(false)
  })

  it('只改标题也算脏', () => {
    const state = editDraft(createEditorState(makeDoc()), { title: '新标题' })
    expect(isDirty(state)).toBe(true)
  })
})

describe('保存请求', () => {
  it('带的是基线版本号，不是草稿版本', () => {
    const dirty = editDraft(createEditorState(makeDoc()), { content: '改了' })
    const { state, request } = beginSave(dirty)
    expect(request).not.toBeNull()
    expect(request?.baseVersion).toBe(3)
    expect(request?.content).toBe('改了')
    expect(state.status).toBe('saving')
  })

  it('没改动时不发空请求', () => {
    const { request } = beginSave(createEditorState(makeDoc()))
    expect(request).toBeNull()
  })

  it('保存中不重复提交', () => {
    const dirty = editDraft(createEditorState(makeDoc()), { content: '改了' })
    const first = beginSave(dirty)
    const second = beginSave(first.state)
    expect(second.request).toBeNull()
  })

  it('viewer 不能保存（只读角色一律拒绝）', () => {
    const state = editDraft(createEditorState(asRole('viewer')), { content: '偷偷改' })
    expect(canEdit(state)).toBe(false)
    expect(canSave(state)).toBe(false)
    expect(beginSave(state).request).toBeNull()
  })

  it.each(['owner', 'editor'] as DocRole[])('%s 可以保存', (role) => {
    const state = editDraft(createEditorState(asRole(role)), { content: '改了' })
    expect(canSave(state)).toBe(true)
  })
})

describe('保存成功', () => {
  it('版本号前移、草稿保留、脏归零', () => {
    const dirty = editDraft(createEditorState(makeDoc()), { content: '改了' })
    const begun = beginSave(dirty)
    const saved = applySaved(begun.state, makeDoc({ content: '改了', version: 4 }))

    expect(saved.base.version).toBe(4)
    expect(saved.draft.content).toBe('改了')
    expect(isDirty(saved)).toBe(false)
    expect(saved.status).toBe('idle')
  })

  it('保存期间又改了 → 依旧是脏的，不会吞字', () => {
    const dirty = editDraft(createEditorState(makeDoc()), { content: '第一版' })
    const begun = beginSave(dirty)
    // 请求在飞的时候用户继续打字
    const typedMore = editDraft(begun.state, { content: '第一版 + 第二段' })
    const saved = applySaved(typedMore, makeDoc({ content: '第一版', version: 4 }))

    expect(saved.draft.content).toBe('第一版 + 第二段')
    expect(isDirty(saved)).toBe(true)
    expect(saved.status).toBe('dirty')
  })
})

describe('409 冲突', () => {
  const current = makeDoc({ content: '别人写的内容', version: 9, updatedAt: '2026-11-17T11:00:00.000Z' })

  it('记下服务端行，但基线不动（关键）', () => {
    const dirty = editDraft(createEditorState(makeDoc()), { content: '我的内容' })
    const conflicted = applyConflict(dirty, current)

    expect(conflicted.status).toBe('conflict')
    expect(conflicted.conflict?.version).toBe(9)
    // 基线保持旧版本 —— 换成新版本会让界面误以为已同步
    expect(conflicted.base.version).toBe(3)
    expect(conflicted.draft.content).toBe('我的内容')
  })

  it('覆盖：用服务端最新版本号重发，内容仍是我的', () => {
    const dirty = editDraft(createEditorState(makeDoc()), { content: '我的内容' })
    const conflicted = applyConflict(dirty, current)
    const { state, request } = resolveConflict(conflicted, 'overwrite')

    expect(request?.baseVersion).toBe(9)
    expect(request?.content).toBe('我的内容')
    expect(state.status).toBe('saving')
  })

  it('重载：接受服务端内容，本地草稿清空', () => {
    const dirty = editDraft(createEditorState(makeDoc()), { content: '我的内容' })
    const conflicted = applyConflict(dirty, current)
    const { state, request } = resolveConflict(conflicted, 'reload')

    expect(request).toBeNull()
    expect(state.base.version).toBe(9)
    expect(state.draft.content).toBe('别人写的内容')
    expect(isDirty(state)).toBe(false)
    expect(state.status).toBe('idle')
  })

  it('取消：本地草稿一个字都不丢', () => {
    const dirty = editDraft(createEditorState(makeDoc()), { content: '我的内容' })
    const conflicted = applyConflict(dirty, current)
    const { state } = resolveConflict(conflicted, 'cancel')

    expect(state.draft.content).toBe('我的内容')
    expect(state.status).toBe('dirty')
    expect(state.conflict).toBeNull()
    expect(canSave(state)).toBe(true)
  })

  it('没有冲突时三选一都不产生请求', () => {
    const state = editDraft(createEditorState(makeDoc()), { content: '改了' })
    expect(resolveConflict(state, 'overwrite').request).toBeNull()
    expect(resolveConflict(state, 'reload').state).toBe(state)
  })
})

describe('其他失败', () => {
  it('403 保留草稿，给出可翻译的错误码', () => {
    const dirty = editDraft(createEditorState(asRole('viewer')), { content: '改了' })
    const failed = applyError(dirty, 'forbidden')

    expect(failed.status).toBe('error')
    expect(failed.error).toBe('forbidden')
    expect(failed.draft.content).toBe('改了')
  })

  it('重新动手后错误提示消失', () => {
    const failed = applyError(createEditorState(makeDoc()), 'not_found')
    const retried = editDraft(failed, { content: '再试一次' })
    expect(retried.error).toBeNull()
  })
})

describe('离开保护', () => {
  it('有未保存内容要拦', () => {
    expect(shouldWarnBeforeLeave(createEditorState(makeDoc()))).toBe(false)
    expect(shouldWarnBeforeLeave(editDraft(createEditorState(makeDoc()), { content: 'x' }))).toBe(true)
  })

  it('保存中也要拦（别在半路关页）', () => {
    const dirty = editDraft(createEditorState(makeDoc()), { content: '改了' })
    expect(shouldWarnBeforeLeave(beginSave(dirty).state)).toBe(true)
  })
})

describe('冲突说明文案', () => {
  it('算出字数增减与标题是否变化', () => {
    const delta = draftDelta({ title: '标题', content: '12345' }, { title: '新标题', content: '123' })
    expect(delta.charDelta).toBe(-2)
    expect(delta.chars).toBe(3)
    expect(delta.titleChanged).toBe(true)
  })
})
