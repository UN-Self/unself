// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node 运行体数据库装配（#360 轨道 C）：按 `UNSELF_DB` 方言打开控制面，
 * 用 `ControlPlane.applyMigrations('core', files)` 跑 core 迁移（不自己写记账）。
 *
 * 执行器作为 `env.CORE_DB` 使用：workbench 的业务 SQL 只用 D1 的
 * prepare().bind().first()/all()/run() 子集，`ControlPlaneExecutor` 与之同形；
 * 少数零参查询直接 `prepare(sql).all()`，由 `d1-executor.ts` 补一层薄形状适配（不复制 SQL）。
 * PG 侧注意 `toPgSql` 的已知边界：
 * 裸 `? 'k'`（jsonb 存在操作符）会被当占位符改写；core 列全是 TEXT、不用 jsonb 操作符，
 * 因此可接受（契约见 core/control-plane/src/placeholder.ts）。
 */
import type { ApplyReport, ControlPlane, ControlPlaneExecutor } from '@unself/control-plane';
import { PgControlPlane, PgExecutor, SqliteControlPlane, SqliteExecutor, openCoreDb } from '@unself/control-plane';
import type { SyncTransactionRunner, TransactionOp, TransactionRunner } from './d1-executor';
import { Pool } from 'pg';
import type { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DatabaseConfig } from './config';

export interface NodeDatabase {
  dialect: 'sqlite' | 'postgres';
  controlPlane: ControlPlane;
  executor: ControlPlaneExecutor;
  migrationReport: ApplyReport;
  /**
   * 异步事务（PG）：回调拿到「事务内执行器」，语句必须走事务连接（pool 会把语句派发到
   * 别的连接，事务就不成立）。sqlite 不提供这条——同步驱动请用 `transactionSync`。
   */
  transaction?: TransactionRunner;
  /**
   * 同步事务（sqlite）：BEGIN…COMMIT 之间零 await。node:sqlite 是同步 API，走异步事务
   * 会让微任务插进事务中间（见 d1-executor.ts 的 SyncTransactionRunner 注释）。
   */
  transactionSync?: SyncTransactionRunner;
  close(): Promise<void>;
}

/** 迁移文件：sqlite 用 `migrations/core/*.sql`，PG 用 `migrations/pg/*.pg.sql`（记账名会去掉 .pg）。 */
async function readMigrations(
  rootDir: string,
  dialect: 'sqlite' | 'postgres',
): Promise<Array<{ name: string; sql: string }>> {
  const dir = join(rootDir, dialect === 'postgres' ? 'pg' : 'core');
  const names = (await readdir(dir))
    .filter((name) => (dialect === 'postgres' ? name.endsWith('.pg.sql') : name.endsWith('.sql')))
    .sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })));
}

/**
 * sqlite 事务（同步）：node:sqlite 的语句执行是同步的，BEGIN…COMMIT 之间一次 await 都
 * 不能有——`await` 会让出微任务队列，别的请求的语句就挤进同一个事务；本事务失败
 * ROLLBACK 时会连带撤掉那些请求已经回 200 的写，两个并发 batch 还会撞
 * "cannot start a transaction within a transaction"。语句在主线程上一口气跑完才是真原子。
 */
function runSqliteTransactionSync(db: DatabaseSync, ops: readonly TransactionOp[]): unknown[] {
  db.exec('BEGIN');
  try {
    const out = ops.map(({ sql, params }) => {
      const info = db.prepare(sql).run(...(params as never[]));
      return { meta: { changes: Number(info.changes) } };
    });
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** PG 事务：必须独占一条连接（pool 会把语句派发到任意连接，那样事务不成立）。 */
async function runPgTransaction<T>(
  pool: Pool,
  fn: (tx: ControlPlaneExecutor) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(new PgExecutor(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 打开数据库、跑迁移、回执行器与关闭钩子。 */
export async function openNodeDatabase(
  config: DatabaseConfig,
  migrationsDir: string,
): Promise<NodeDatabase> {
  if (config.kind === 'postgres') {
    // 不走 PgControlPlane.open（它会 ensureCoreSchema 建最终列集），否则迁移链的
    // ALTER ADD COLUMN 会撞「列已存在」。真源是迁移文件，这里只提供连接池。
    const pool = new Pool({ connectionString: config.url });
    const cp = new PgControlPlane(pool);
    const report = await cp.applyMigrations('core', await readMigrations(migrationsDir, 'postgres'));
    return {
      dialect: 'postgres',
      controlPlane: cp,
      executor: new PgExecutor(cp.pool),
      transaction: (fn) => runPgTransaction(pool, fn),
      close: () => cp.close(),
      migrationReport: report,
    };
  }
  // 同理不走 SqliteControlPlane.open 的 ensureSchema：表形状只由迁移链定义。
  const { db } = openCoreDb(config.path);
  const cp = new SqliteControlPlane(db);
  const report = await cp.applyMigrations('core', await readMigrations(migrationsDir, 'sqlite'));
  return {
    dialect: 'sqlite',
    controlPlane: cp,
    executor: new SqliteExecutor(cp.db),
    transactionSync: (ops) => runSqliteTransactionSync(db, ops),
    close: async () => {
      db.close();
    },
    migrationReport: report,
  };
}
