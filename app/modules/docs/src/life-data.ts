// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 生命周期业务体（docs/modules.md §8「生命周期」+ core/contracts lifecycle.ts）：全模块导出与清除。
 *
 * 面向平台侧操作方（卸载「导出并删除 / 直接删除」、备份剧本），按**模块级**处理——不看
 * token 的 sub（hello 模块同口径）。代价是任何持有效模块 token 的用户都能清全库，契约
 * 未给管理面额外鉴权强度，缓解靠部署纪律（README 声明 token 等同模块管理凭据）。
 *
 * 导出形状固定为契约 ExportBundle：{ version: 1, moduleId, exportedAt, tables, files }。
 * - 三张业务表全量行（含软删行：卸载备份要完整现场）；
 * - 不导迁移账本 unself_migrations_docs（记账，非业务数据）；
 * - files 恒为空数组（docs 无对象存储引用）。
 *
 * purge 是硬删（DELETE，不是软删打标）：表结构保留、账本表不动，重复调用幂等。
 */
import type { D1Like } from './d1';

export const EXPORT_BUNDLE_VERSION = 1;

/** 契约 ExportBundle 的结构化子集（rows 行形状归各表 schema，不做二次校验）。 */
export interface LifeExportBundle {
  version: typeof EXPORT_BUNDLE_VERSION;
  moduleId: string;
  exportedAt: string;
  tables: Record<string, { schemaVersion: number; rows: unknown[] }>;
  files: unknown[];
}

/** 逐批行数：一页进内存、拼进 rows 后释放引用，导出不再受整表驻留限制。 */
const EXPORT_BATCH_SIZE = 500;

/** 导出的三张表 → 建表列（与 migrations/docs/0001_baseline.sql 一一对应；新增迁移要同步这里）。 */
const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  docs_documents: ['id', 'title', 'content', 'owner_id', 'version', 'created_at', 'updated_at', 'deleted_at'],
  docs_document_members: ['doc_id', 'user_id', 'role'],
  docs_document_comments: ['id', 'doc_id', 'author_id', 'body', 'created_at', 'deleted_at'],
};

/**
 * 逐表分页导出（keyset：按 rowid 有序，WHERE rowid > 上批末行继续翻，页内无偏移扫描）。
 * rowid 显式 SELECT 进行再剥掉——SELECT * 不带它，游标取不到值会 bind(undefined) 中断导出；
 * 剥离后行仍是 snake_case 原始列（卸载备份要能按原 schema 复原）。表名是本文件常量，插值无注入面。
 */
async function dumpTable(db: D1Like, table: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor = 0;
  for (;;) {
    const { results } = await db
      .prepare(
        `SELECT rowid AS __rowid, ${columnsOf(table).map((column) => `"${column}"`).join(', ')}
           FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${EXPORT_BATCH_SIZE}`,
      )
      .bind(cursor)
      .all<Record<string, unknown> & { __rowid: number }>();
    if (results.length === 0) break;
    cursor = results.at(-1)!.__rowid;
    for (const { __rowid: _, ...row } of results) rows.push(row);
  }
  return rows;
}

/** 三张表的列（读 schema 缓存一次；导出列名与建表列一一对应，不写死第二份）。 */
function columnsOf(table: string): readonly string[] {
  return TABLE_COLUMNS[table] ?? [];
}

/** 全模块导出：三张业务表 → 契约 ExportBundle 形状。 */
export async function exportAllData(db: D1Like, moduleId: string): Promise<LifeExportBundle> {
  return {
    version: EXPORT_BUNDLE_VERSION,
    moduleId,
    exportedAt: new Date().toISOString(),
    tables: {
      docs_documents: { schemaVersion: 1, rows: await dumpTable(db, 'docs_documents') },
      docs_document_members: { schemaVersion: 1, rows: await dumpTable(db, 'docs_document_members') },
      docs_document_comments: { schemaVersion: 1, rows: await dumpTable(db, 'docs_document_comments') },
    },
    files: [],
  };
}

/** 全模块清除：硬删三张业务表全部行；返回影响行数（调用方可打日志）。幂等。 */
export async function purgeAllData(db: D1Like): Promise<{ documents: number; members: number; comments: number }> {
  const deleted = async (table: string): Promise<number> => {
    const result = await db.prepare(`DELETE FROM ${table}`).run();
    return result.meta.changes ?? 0;
  };
  return {
    comments: await deleted('docs_document_comments'),
    members: await deleted('docs_document_members'),
    documents: await deleted('docs_documents'),
  };
}
