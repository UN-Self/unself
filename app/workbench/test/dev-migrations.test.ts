// SPDX-License-Identifier: AGPL-3.0-only
/**
 * dev.mjs 迁移逻辑行为测试（pnpm dev 的核心承诺：与 wrangler d1 migrations apply
 * 同语义——按 d1_migrations 记账，已应用跳过、失败停住不记账）。
 * 只测 applyCoreMigrations 纯函数核心（dbPath/migrationsDir 注入临时目录），
 * 不起 wrangler（端到端形态由 dev 一条命令真跑取证，见提交信息）。
 * dev.mjs 顶层无副作用（直执行守卫），import 即可拿纯函数。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { applyCoreMigrations } from '../scripts/dev.mjs';

const tmpRoot = mkdtempSync(join(tmpdir(), 'dev-migrations-test-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function fixture(files: Record<string, string>): { dbPath: string; dir: string } {
  const dir = join(tmpRoot, `m${Object.keys(files).length}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return { dbPath: join(tmpRoot, `db-${Math.random().toString(36).slice(2, 6)}.sqlite`), dir };
}

describe('applyCoreMigrations（pnpm dev 自动迁移）', () => {
  it('首跑全应用 + 记账；二跑按记账全跳过（幂等）', () => {
    const { dbPath, dir } = fixture({
      '0001_a.sql': 'CREATE TABLE IF NOT EXISTS t_a (id TEXT);',
      '0002_b.sql': 'CREATE TABLE IF NOT EXISTS t_b (id TEXT);',
    });
    const first = applyCoreMigrations(dbPath, dir);
    expect(first.applied).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(first.skipped).toEqual([]);

    const second = applyCoreMigrations(dbPath, dir);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['0001_a.sql', '0002_b.sql']);

    // 记账表形状 = wrangler d1_migrations（名字进账，wrangler 时代的库直接认）
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT name FROM d1_migrations ORDER BY name').all();
    db.close();
    expect(rows.map((r) => String(r.name))).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('新增文件只应用增量（老库升级路径）', () => {
    const { dbPath, dir } = fixture({ '0001_a.sql': 'CREATE TABLE IF NOT EXISTS t_a (id TEXT);' });
    applyCoreMigrations(dbPath, dir);
    // 升级：仓库加了 0002（模拟拉新代码后再 pnpm dev）
    writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE IF NOT EXISTS t_b (id TEXT);');
    const again = applyCoreMigrations(dbPath, dir);
    expect(again.applied).toEqual(['0002_b.sql']);
    expect(again.skipped).toEqual(['0001_a.sql']);
  });

  it('失败文件不记账、报错带文件名（停住不重试）', () => {
    const { dbPath, dir } = fixture({
      '0001_ok.sql': 'CREATE TABLE IF NOT EXISTS t_ok (id TEXT);',
      '0002_bad.sql': 'THIS IS NOT SQL;',
    });
    expect(() => applyCoreMigrations(dbPath, dir)).toThrow(/0002_bad\.sql/);
    // 坏文件未记账；好的已记账（重跑只重放坏的——#61 语义）
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT name FROM d1_migrations').all();
    db.close();
    expect(rows.map((r) => String(r.name))).toEqual(['0001_ok.sql']);
  });
});
