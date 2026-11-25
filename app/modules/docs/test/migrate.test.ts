// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 迁移执行器验收（#358 T2）：启动时自跑迁移 + 独立记账 + 失败不记账。
 * 用真迁移文件 + 真 SQLite，不假造「已记账」状态。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { applyMigrations, DOCS_MIGRATIONS_LEDGER } from '../src/migrate';
import { createDocsDb } from './d1-memory';

function baselineSql(): string {
  return readFileSync(new URL('../migrations/docs/0001_baseline.sql', import.meta.url), 'utf8');
}

describe('迁移执行器 + 记账表（T2）', () => {
  it('空库首次启动：执行 0001 并记账', async () => {
    const db = createDocsDb({ migrate: false });
    try {
      const outcome = await applyMigrations(db.d1, [{ name: '0001_baseline.sql', sql: baselineSql() }]);
      expect(outcome).toEqual({ applied: ['0001_baseline.sql'], skipped: [] });

      expect(db.query(`SELECT name FROM ${DOCS_MIGRATIONS_LEDGER} ORDER BY name`)).toEqual([
        { name: '0001_baseline.sql' },
      ]);
      expect(db.columns('docs_documents')).toContain('version');
    } finally {
      db.close();
    }
  });

  it('二次启动：账上有就跳过，不重复执行', async () => {
    const db = createDocsDb({ migrate: false });
    try {
      const files = [{ name: '0001_baseline.sql', sql: baselineSql() }];
      await applyMigrations(db.d1, files);

      const second = await applyMigrations(db.d1, files);
      expect(second).toEqual({ applied: [], skipped: ['0001_baseline.sql'] });
      expect(db.query(`SELECT COUNT(*) AS n FROM ${DOCS_MIGRATIONS_LEDGER}`)).toEqual([{ n: 1 }]);
    } finally {
      db.close();
    }
  });

  it('失败不记账：坏文件报错带文件名，好文件已入账，重跑只补坏的', async () => {
    const db = createDocsDb({ migrate: false });
    try {
      const good = { name: '0001_good.sql', sql: 'CREATE TABLE IF NOT EXISTS t_good (id TEXT);' };
      const bad = { name: '0002_bad.sql', sql: 'THIS IS NOT SQL;' };

      await expect(applyMigrations(db.d1, [good, bad])).rejects.toThrow(/0002_bad\.sql failed/);
      expect(db.query(`SELECT name FROM ${DOCS_MIGRATIONS_LEDGER} ORDER BY name`)).toEqual([
        { name: '0001_good.sql' },
      ]);

      // 修好坏文件后重跑：只应用它，好的不重放
      const fixed = { name: '0002_bad.sql', sql: 'CREATE TABLE IF NOT EXISTS t_bad (id TEXT);' };
      const outcome = await applyMigrations(db.d1, [good, fixed]);
      expect(outcome).toEqual({ applied: ['0002_bad.sql'], skipped: ['0001_good.sql'] });
    } finally {
      db.close();
    }
  });

  it('老库升级：新增迁移只应用增量，已记账旧文件不重跑', async () => {
    const db = createDocsDb({ migrate: false });
    try {
      const v1 = { name: '0001_baseline.sql', sql: baselineSql() };
      await applyMigrations(db.d1, [v1]);

      const v2 = { name: '0002_add_comments.sql', sql: 'CREATE INDEX IF NOT EXISTS idx_tmp ON docs_documents (title);' };
      const outcome = await applyMigrations(db.d1, [v1, v2]);
      expect(outcome).toEqual({ applied: ['0002_add_comments.sql'], skipped: ['0001_baseline.sql'] });
    } finally {
      db.close();
    }
  });

  it('账本独立：自建 unself_migrations_docs，不碰平台 d1_migrations', async () => {
    const db = createDocsDb({ migrate: false });
    try {
      await applyMigrations(db.d1, [{ name: '0001_baseline.sql', sql: baselineSql() }]);
      const tables = db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
      const names = tables.map((row) => row.name);
      expect(names).toContain(DOCS_MIGRATIONS_LEDGER);
      expect(names).not.toContain('d1_migrations');
    } finally {
      db.close();
    }
  });
});
