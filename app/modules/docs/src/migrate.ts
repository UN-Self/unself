// SPDX-License-Identifier: AGPL-3.0-only
/**
 * docs 模块迁移执行器（#358 T2）：模块启动时自己跑迁移，按独立记账表逐份幂等应用。
 *
 * 为什么自带执行器：docs 落点 storage=self（模块自带 SQLite，平台不接线、不跑迁移），
 * 迁移只能由模块自己在启动时应用。账本按模块独立（`unself_migrations_docs`），沿用仓库根
 * AGENTS.md「已知坑」里的同一条纪律——多个模块共用一个库时各自用独立记账表，否则同名迁移
 * 会被跳过；docs 现在独占一个库文件，这条是为将来共库留的。
 *
 * 语义（与 core/control-plane 的 wrangler d1 migrations 对齐）：
 * - 文件名即记账键；账上有就跳过，没有才执行；
 * - **整份文件跑成功之后才记账**：中途失败不记账，重跑整份重放（SQL 必须逐条幂等，
 *   见 0001_baseline.sql 的 IF NOT EXISTS / INSERT OR IGNORE）；
 * - 单实例内串行执行；多 isolate 并发启动时，幂等 SQL + `INSERT OR IGNORE` 兜住重复应用。
 *
 * 依赖面：只用 `exec`（多语句直接交给 SQLite 解析，避免自己切分号踩 CREATE TRIGGER 的坑）
 * 和 `prepare().all()/run()`。真实 D1Database / node:sqlite 适配器都满足。
 */

import type { D1Executable } from './d1';

export interface MigrationFile {
  /** 记账键 = 迁移文件名（如 `0001_baseline.sql`）。 */
  name: string;
  sql: string;
}

/** 独立记账表：不与平台 D1 的 d1_migrations、也不与其他模块共用。 */
export const DOCS_MIGRATIONS_LEDGER = 'unself_migrations_docs';

export interface MigrationOutcome {
  applied: string[];
  skipped: string[];
}

/** 建账本（幂等；每次启动都先确保它在）。 */
async function ensureLedger(db: D1Executable): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${DOCS_MIGRATIONS_LEDGER} (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
}

async function appliedNames(db: D1Executable): Promise<Set<string>> {
  const { results } = await db
    .prepare(`SELECT name FROM ${DOCS_MIGRATIONS_LEDGER}`)
    .all<{ name: string }>();
  return new Set(results.map((row) => row.name));
}

/**
 * 应用全部未记账迁移（按文件名排序）。
 * 返回本次实际执行 / 跳过的文件名，调用方可打日志。
 */
export async function applyMigrations(
  db: D1Executable,
  files: readonly MigrationFile[],
): Promise<MigrationOutcome> {
  await ensureLedger(db);
  const done = await appliedNames(db);
  const outcome: MigrationOutcome = { applied: [], skipped: [] };

  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(file.name)) {
      outcome.skipped.push(file.name);
      continue;
    }
    try {
      await db.exec(file.sql);
    } catch (error) {
      throw new Error(`migration ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    // 记账在整份文件成功之后：失败不记账，下次整份重放。
    await db
      .prepare(`INSERT OR IGNORE INTO ${DOCS_MIGRATIONS_LEDGER} (name) VALUES (?)`)
      .bind(file.name)
      .run();
    outcome.applied.push(file.name);
  }

  return outcome;
}
