// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PgControlPlane 真库测试（#360 轨道 B）：连不上 PostgreSQL 时整组 skipped，不 failed。
 *
 * 用法：设置环境变量 UNSELF_TEST_PG_URL（libpq 连接串）后跑 pnpm --filter @unself/control-plane test。
 * 每个测试文件在独立 schema 里跑（DROP/CREATE SCHEMA），用完删干净，不碰目标库已有数据。
 *
 * 建表走**真迁移链** `app/workbench/migrations/pg/0001–0017`（不是 ensureCoreSchema 抄一份），
 * 行为契约用例再跑在迁移后的真实形状上：迁移与 SQL 单点错位会当场红。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgControlPlane } from '../src/pg';
import { defineControlPlaneContract } from './control-plane-cases';

const PG_URL = process.env.UNSELF_TEST_PG_URL;
const SCHEMA = `unself_pg_test_${process.pid}_${Date.now()}`;

describe.skipIf(!PG_URL)('PgControlPlane（真 PostgreSQL）', () => {
  let admin: Pool;
  let pool: Pool;
  let cp: PgControlPlane;

  beforeAll(async () => {
    if (!PG_URL) throw new Error('UNSELF_TEST_PG_URL 未设置');
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${SCHEMA}`, max: 4 });
    cp = new PgControlPlane(pool);

    const dir = fileURLToPath(new URL('../../../app/workbench/migrations/pg/', import.meta.url));
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.pg.sql'))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
    const report = await cp.applyMigrations('core', files);
    expect(report.applied).toHaveLength(files.length);
    expect(files.map((f) => f.name)).toContain('0001_init.pg.sql');
    expect(files.map((f) => f.name)).toContain('0017_registry_mode_two_values.pg.sql');
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await admin?.end();
  });

  it('全部迁移按文件名记账：`.pg` 归一后与 SQLite 记账键一致', async () => {
    const names = await cp.appliedMigrations('core');
    expect(names).toHaveLength(17);
    expect(names).toContain('0001_init.sql');
    expect(names).toContain('0017_registry_mode_two_values.sql');
    expect(names).not.toContain('0017_registry_mode_two_values.pg.sql');
  });

  defineControlPlaneContract('契约行为（与 SQLite / D1 同语义）', async () => ({
    cp,
    seal: async () => {
      await pool.query(
        "INSERT INTO instance_config (key, value) VALUES ('setup_done', '1') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      );
    },
    reset: async () => {
      await pool.query('TRUNCATE instance_config, setup_tokens, module_registry');
      const ledgers = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'unself_migrations_%'",
      );
      for (const row of ledgers.rows as Array<{ tablename: string }>) {
        await pool.query(`DROP TABLE IF EXISTS ${row.tablename}`);
      }
    },
    close: async () => undefined,
  }));
});
