// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 内存版 docs API：让编辑器在 D5 落地前就能真跑（含 409 冲突）。
 *
 * 行为刻意贴着后端实现（PR #366 repo/documents.ts）：
 * - baseVersion 与库内 version 不等 → 409，并把服务端当前行带回来；
 * - 保存成功 version + 1，updatedAt 刷新；
 * - viewer 写入 → 403 forbidden。
 * 这样「联调时才发现语义不对」的坑，在这里就撞掉。
 */
import { DocsApiError, type DocsApi } from './docs-api'
import type { Doc, DocDraft, DocRole, SaveRequest, SaveResult } from './docs-types'

/** 评论行：deletedAt 非空即软删占位（表契约 docs_document_comments.deleted_at）。 */
export interface DocComment {
  id: string
  docId: string
  authorId: string
  authorName: string
  body: string
  createdAt: string
  deletedAt?: string | null
}

export interface CommentsApi {
  /** 时间线按 created_at 升序；软删行带 deletedAt 返回（占位防跳变，见评论契约提案）。 */
  listComments(docId: string): Promise<DocComment[]>
  addComment(docId: string, body: string): Promise<DocComment>
  /** 软删：打 deleted_at 标记，行不消失。 */
  deleteComment(docId: string, commentId: string): Promise<void>
}

/** mock 额外暴露的「夹具开关」，只在原型/测试里用，不属于 DocsApi。 */
export interface MockDocsApi extends DocsApi {
  /** 模拟别人存了一版：版本号 +1，内容被改。用来制造 409。 */
  remoteSave(patch: Partial<DocDraft>): Doc
  setRole(role: DocRole): void
  current(): Doc
}

const SEED: Doc = {
  id: 'doc_seed_1',
  title: '云笺 · 设计取舍',
  content: [
    '# 云笺',
    '',
    '一个跑在自托管平台上的 Markdown 协作文档。',
    '',
    '## 有意不做的',
    '',
    '- 富文本、协同编辑（CRDT / OT）',
    '- 版本历史、全文搜索',
    '',
    '## 并发策略',
    '',
    '保存时带 `baseVersion`，服务端用 `UPDATE ... WHERE version = ?` 做条件更新：',
    '',
    '```sql',
    'UPDATE docs_documents',
    '   SET content = ?, version = version + 1',
    ' WHERE id = ? AND version = ? AND deleted_at IS NULL',
    '```',
    '',
    '影响 0 行即冲突，返回 409 与服务端当前内容，由前端让用户选「覆盖 / 重载 / 取消」。',
    '',
    '> 这不是实时系统，别包装成实时系统。',
  ].join('\n'),
  ownerId: 'u_1',
  version: 1,
  createdAt: '2026-11-17T10:00:00.000Z',
  updatedAt: '2026-11-17T10:00:00.000Z',
  role: 'owner',
}

function nowIso(): string {
  return new Date().toISOString()
}

export function createMockDocsApi(seed: Doc = SEED): MockDocsApi {
  let doc: Doc = { ...seed }

  return {
    current: () => ({ ...doc }),

    async getDoc(id: string): Promise<Doc> {
      if (id !== doc.id) throw new DocsApiError('not_found', 404)
      return { ...doc }
    },

    async saveDoc(request: SaveRequest): Promise<SaveResult> {
      if (doc.role === 'viewer') throw new DocsApiError('forbidden', 403)
      if (request.baseVersion !== doc.version) {
        return { ok: false, reason: 'conflict', current: { ...doc } }
      }
      doc = {
        ...doc,
        title: request.title,
        content: request.content,
        version: doc.version + 1,
        updatedAt: nowIso(),
      }
      return { ok: true, doc: { ...doc } }
    },

    remoteSave(patch: Partial<DocDraft>): Doc {
      doc = {
        ...doc,
        title: patch.title ?? doc.title,
        content: patch.content ?? doc.content,
        version: doc.version + 1,
        updatedAt: nowIso(),
      }
      return { ...doc }
    },

    setRole(role: DocRole): void {
      doc = { ...doc, role }
    },
  }
}

/** 评论的 mock（D10）：接口形状待 D5 定稿，先按 RESTful 惯例留位（见 docs/评论契约提案.md）。 */
export function createMockCommentsApi(seed: DocComment[] = []): CommentsApi {
  const store = new Map<string, DocComment[]>()
  let seq = 0

  if (seed.length > 0) {
    const byDoc = new Map<string, DocComment[]>()
    for (const item of seed) {
      byDoc.set(item.docId, [...(byDoc.get(item.docId) ?? []), item])
    }
    for (const [docId, list] of byDoc) store.set(docId, [...list])
  }

  return {
    async listComments(docId: string): Promise<DocComment[]> {
      return [...(store.get(docId) ?? [])]
    },
    async addComment(docId: string, body: string): Promise<DocComment> {
      seq += 1
      const comment: DocComment = {
        id: `c_${seq}`,
        docId,
        authorId: 'u_1',
        authorName: '我',
        body,
        createdAt: nowIso(),
        deletedAt: null,
      }
      store.set(docId, [...(store.get(docId) ?? []), comment])
      return comment
    },
    async deleteComment(docId: string, commentId: string): Promise<void> {
      const list = store.get(docId) ?? []
      store.set(
        docId,
        list.map((item) =>
          item.id === commentId && item.deletedAt == null ? { ...item, deletedAt: nowIso() } : item,
        ),
      )
    },
  }
}
