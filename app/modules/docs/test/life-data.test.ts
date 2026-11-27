// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 生命周期业务体验收（D6）：导出形状对齐契约 ExportBundle、purge 硬删且幂等、
 * 账本表（unself_migrations_docs）不被清除。
 */
import { describe, expect, it } from 'vitest';

import { EXPORT_BUNDLE_VERSION, exportAllData, purgeAllData } from '../src/life-data';
import { createDocument } from '../src/repo/documents';
import { createDocsDb } from './d1-memory';

/** 种三张表各若干行（含软删行与评论），返回文档 id 供断言。 */
async function seed(db: ReturnType<typeof createDocsDb>) {
  const doc = await createDocument(db.d1, { ownerId: 'u1', title: 't', content: 'c' });
  const deleted = await createDocument(db.d1, { ownerId: 'u1', title: 'gone' });
  db.run("UPDATE docs_documents SET deleted_at = datetime('now') WHERE id = ?", deleted.id);
  db.run("INSERT INTO docs_document_members (doc_id, user_id, role) VALUES (?, 'u2', 'editor')", doc.id);
  db.run("INSERT INTO docs_document_comments (id, doc_id, author_id, body) VALUES ('c1', ?, 'u2', 'hi')", doc.id);
  return { docId: doc.id, deletedId: deleted.id };
}

describe('exportAllData', () => {
  it('导出形状对齐契约：version/moduleId/exportedAt/tables/files', async () => {
    const db = createDocsDb();
    try {
      const { docId } = await seed(db);
      const bundle = await exportAllData(db.d1, 'docs');
      expect(bundle.version).toBe(EXPORT_BUNDLE_VERSION);
      expect(bundle.moduleId).toBe('docs');
      expect(new Date(bundle.exportedAt).toString()).not.toBe('Invalid Date');
      expect(bundle.files).toEqual([]);
      expect(Object.keys(bundle.tables).sort()).toEqual([
        'docs_document_comments',
        'docs_document_members',
        'docs_documents',
      ]);
      expect(bundle.tables.docs_documents!).toMatchObject({ schemaVersion: 1 });
      expect(bundle.tables.docs_documents!.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: docId, title: 't' }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('软删行也在导出包里（卸载备份要完整现场）；账本表不在包内', async () => {
    const db = createDocsDb();
    try {
      const { deletedId } = await seed(db);
      const bundle = await exportAllData(db.d1, 'docs');
      expect(bundle.tables.docs_documents!.rows).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: deletedId, deleted_at: expect.any(String) })]),
      );
      expect(Object.keys(bundle.tables)).not.toContain('unself_migrations_docs');
    } finally {
      db.close();
    }
  });
});

describe('exportAllData 分页', () => {
  it('超过一批（>500 行）不丢行、不重复（keyset 游标逐批拼）', async () => {
    const db = createDocsDb();
    try {
      for (let i = 0; i < 1205; i += 1) {
        db.run('INSERT INTO docs_documents (id, title, owner_id) VALUES (?, ?, ?)', `d_${i}`, `t${i}`, 'u1');
      }
      const bundle = await exportAllData(db.d1, 'docs');
      const rows = bundle.tables.docs_documents!.rows as Array<{ id: string }>;
      expect(rows).toHaveLength(1205);
      expect(new Set(rows.map((row) => row.id)).size).toBe(1205);
    } finally {
      db.close();
    }
  });
});

describe('purgeAllData', () => {
  it('硬删三张表全部行，账本表不动；幂等', async () => {
    const db = createDocsDb();
    try {
      await seed(db);
      const first = await purgeAllData(db.d1);
      expect(first).toEqual({ comments: 1, members: 1, documents: 2 });
      for (const table of ['docs_documents', 'docs_document_members', 'docs_document_comments']) {
        expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`)).toEqual([{ n: 0 }]);
      }
      // 账本表不在 d1-memory 测试库（它由 src/migrate.ts 启动期建）；「账本不被清」的依据
      // 是 life-data.ts 的 DELETE 只列三张具名业务表，无前缀扫描——此处靠目检守护。
      const second = await purgeAllData(db.d1);
      expect(second).toEqual({ comments: 0, members: 0, documents: 0 });

      // 组合语义：清完再导出，形状不塌、三张表全空
      const after = await exportAllData(db.d1, 'docs');
      expect(after.version).toBe(EXPORT_BUNDLE_VERSION);
      expect(after.moduleId).toBe('docs');
      expect(Object.keys(after.tables).sort()).toEqual([
        'docs_document_comments',
        'docs_document_members',
        'docs_documents',
      ]);
      for (const table of Object.values(after.tables)) {
        expect(table.rows).toEqual([]);
      }
    } finally {
      db.close();
    }
  });

  it('删除是物理 DELETE：软删行也被清掉', async () => {
    const db = createDocsDb();
    try {
      const { deletedId } = await seed(db);
      await purgeAllData(db.d1);
      expect(db.query('SELECT COUNT(*) AS n FROM docs_documents WHERE id = ?', deletedId)).toEqual([{ n: 0 }]);
    } finally {
      db.close();
    }
  });
});
