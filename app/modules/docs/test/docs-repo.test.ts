// SPDX-License-Identifier: AGPL-3.0-only
/**
 * T2 行为验收（#358）：
 * - 迁移：空库连跑两次成功；表/列与 §5 一致。
 * - 仓储：版本从 1 起、保存严格递增、同 baseVersion 二次保存冲突并回服务端当前内容、
 *   软删后查询/列表/更新一律不可见、列表只给「我的 + 共享给我的」。
 */
import { describe, expect, it } from 'vitest';

import {
  createDocument,
  getDocument,
  listDocuments,
  softDeleteDocument,
  updateDocument,
} from '../src/repo/documents';
import { applyDocsMigrations, createDocsDb } from './d1-memory';

describe('docs 0001_baseline 迁移（D1）', () => {
  it('空库连跑两次都成功（逐条幂等）', () => {
    const db = createDocsDb();
    try {
      expect(() => applyDocsMigrations(db.sqlite)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('三张表存在，列与 §5 一致', () => {
    const db = createDocsDb();
    try {
      expect(db.columns('docs_documents')).toEqual([
        'id',
        'title',
        'content',
        'owner_id',
        'version',
        'created_at',
        'updated_at',
        'deleted_at',
      ]);
      expect(db.columns('docs_document_members')).toEqual(['doc_id', 'user_id', 'role']);
      expect(db.columns('docs_document_comments')).toEqual([
        'id',
        'doc_id',
        'author_id',
        'body',
        'created_at',
        'deleted_at',
      ]);
    } finally {
      db.close();
    }
  });

  it('version 默认 1，members.role 只收 editor / viewer', () => {
    const db = createDocsDb();
    try {
      db.run("INSERT INTO docs_documents (id, title, owner_id) VALUES ('d_a', 't', 'u_owner')");
      expect(db.query<{ version: number }>("SELECT version FROM docs_documents WHERE id = 'd_a'")).toEqual([
        { version: 1 },
      ]);
      expect(() =>
        db.run("INSERT INTO docs_document_members (doc_id, user_id, role) VALUES ('d_a', 'u_x', 'owner')"),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });
});

describe('文档仓储层（D2）', () => {
  it('创建 → 查询：版本从 1 起，owner 与内容落库', async () => {
    const db = createDocsDb();
    try {
      const created = await createDocument(db.d1, { ownerId: 'u_owner', title: '第一版', content: '# hi' });
      expect(created.version).toBe(1);
      expect(created.ownerId).toBe('u_owner');

      const loaded = await getDocument(db.d1, created.id);
      expect(loaded).toEqual(created);
    } finally {
      db.close();
    }
  });

  it('保存成功：内容更新、版本 +1，连续保存严格递增', async () => {
    const db = createDocsDb();
    try {
      const doc = await createDocument(db.d1, { ownerId: 'u_owner', title: 't', content: 'v1' });

      const first = await updateDocument(db.d1, { id: doc.id, baseVersion: 1, content: 'v2' });
      expect(first).toMatchObject({ status: 'ok', document: { content: 'v2', version: 2, title: 't' } });

      const second = await updateDocument(db.d1, { id: doc.id, baseVersion: 2, content: 'v3' });
      expect(second).toMatchObject({ status: 'ok', document: { content: 'v3', version: 3 } });
    } finally {
      db.close();
    }
  });

  it('同一 baseVersion 二次保存 → 冲突，并回服务端当前内容', async () => {
    const db = createDocsDb();
    try {
      const doc = await createDocument(db.d1, { ownerId: 'u_owner', title: 't', content: 'v1' });
      const accepted = await updateDocument(db.d1, { id: doc.id, baseVersion: 1, content: '窗口 A 的内容' });
      expect(accepted.status).toBe('ok');

      // 窗口 B 手里还是 baseVersion=1
      const stale = await updateDocument(db.d1, { id: doc.id, baseVersion: 1, content: '窗口 B 的内容' });
      expect(stale).toEqual({
        status: 'conflict',
        current: expect.objectContaining({ content: '窗口 A 的内容', version: 2 }),
      });

      // 冲突不落库：服务端仍是窗口 A 的内容
      expect((await getDocument(db.d1, doc.id))?.content).toBe('窗口 A 的内容');
    } finally {
      db.close();
    }
  });

  it('不存在 / 已软删的文档保存 → not_found', async () => {
    const db = createDocsDb();
    try {
      expect(await updateDocument(db.d1, { id: 'd_missing', baseVersion: 1, content: 'x' })).toEqual({
        status: 'not_found',
      });

      const doc = await createDocument(db.d1, { ownerId: 'u_owner', title: 't' });
      await softDeleteDocument(db.d1, doc.id);
      expect(await updateDocument(db.d1, { id: doc.id, baseVersion: 1, content: 'x' })).toEqual({
        status: 'not_found',
      });
    } finally {
      db.close();
    }
  });

  it('软删后查询/列表都不可见，行仍在库里；重复删除返回 false', async () => {
    const db = createDocsDb();
    try {
      const doc = await createDocument(db.d1, { ownerId: 'u_owner', title: 't' });

      expect(await softDeleteDocument(db.d1, doc.id)).toBe(true);
      expect(await softDeleteDocument(db.d1, doc.id)).toBe(false);

      expect(await getDocument(db.d1, doc.id)).toBeNull();
      expect(await listDocuments(db.d1, 'u_owner')).toEqual({ items: [], hasMore: false });
      // 软删 = 打标记，不物理删行
      expect(db.query("SELECT deleted_at FROM docs_documents WHERE id = ?", doc.id)).toEqual([
        { deleted_at: expect.any(String) },
      ]);
    } finally {
      db.close();
    }
  });

  it('列表：我拥有的 + 共享给我的可见，非成员不可见，按 updated_at 倒序', async () => {
    const db = createDocsDb();
    try {
      const mine = await createDocument(db.d1, { ownerId: 'u_me', title: '我的' });
      const shared = await createDocument(db.d1, { ownerId: 'u_other', title: '共享给我' });
      const foreign = await createDocument(db.d1, { ownerId: 'u_other', title: '与我无关' });
      const deletedMine = await createDocument(db.d1, { ownerId: 'u_me', title: '已删' });

      db.run(
        "INSERT INTO docs_document_members (doc_id, user_id, role) VALUES (?, 'u_me', 'viewer')",
        shared.id,
      );
      db.run("UPDATE docs_documents SET updated_at = '2026-11-17 10:00:01' WHERE id = ?", mine.id);
      db.run("UPDATE docs_documents SET updated_at = '2026-11-17 10:00:02' WHERE id = ?", shared.id);
      await softDeleteDocument(db.d1, deletedMine.id);

      const { items: list } = await listDocuments(db.d1, 'u_me');
      expect(list.map((doc) => doc.id)).toEqual([shared.id, mine.id]);
      expect(list.map((doc) => doc.role)).toEqual(['viewer', 'owner']);
      expect(list.map((doc) => doc.id)).not.toContain(foreign.id);

      // 另一个成员看不到我的私有文档，只看得到自己拥有/被共享的
      const { items: others } = await listDocuments(db.d1, 'u_other');
      expect(others.map((doc) => doc.id).sort()).toEqual([shared.id, foreign.id].sort());
    } finally {
      db.close();
    }
  });

  it('列表分页：limit 收口在 1..100，offset 生效', async () => {
    const db = createDocsDb();
    try {
      for (let i = 0; i < 3; i += 1) {
        await createDocument(db.d1, { ownerId: 'u_me', title: `t${i}` });
      }
      const first = await listDocuments(db.d1, 'u_me', { limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      // 恰好满页：多取的那条不存在，hasMore 为 false（不靠「满页 = 还有」）
      expect((await listDocuments(db.d1, 'u_me', { limit: 3 })).hasMore).toBe(false);
      expect((await listDocuments(db.d1, 'u_me', { limit: 2, offset: 2 })).items).toHaveLength(1);
      expect((await listDocuments(db.d1, 'u_me', { limit: 0 })).items).toHaveLength(1);
      expect((await listDocuments(db.d1, 'u_me', { limit: 1000 })).items).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});
