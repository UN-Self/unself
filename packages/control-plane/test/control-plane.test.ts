// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ControlPlane 行为测试（真 SQLite，不测实现）：
 * 同一份 SQL 跑在 sqlite 实现上，验证注册表收敛 / setup token 三态 / 原子消费 /
 * 按模块独立记账（#55 护栏①）/ node:sqlite 友好探测。
 * 两问检验：把 upsert 改成「不收敛」（如 INSERT 无 ON CONFLICT）必红；
 * 把记账表改成全局共享（同表）必红。
 */
import { describe, expect, it } from 'vitest';
import { D1ControlPlane } from '../src/d1';
import { SqliteControlPlane } from '../src/sqlite';
import { probeSqlite } from '../src/sqlite-probe';
import { migrationsTableFor } from '../src/types';

const MANIFEST = { id: 'hello', version: '0.1.0', entry: '/m/hello/', runtime: 'worker' };

describe('SqliteControlPlane（真 sqlite）', () => {
  it('core 库不在 CF 时（全新空库）注册表与 setup token 都能写成功', async () => {
    const cp = SqliteControlPlane.open(':memory:');
    const entry = await cp.upsertModule({ id: 'hello', enabled: true, manifest: MANIFEST });
    expect(entry).toMatchObject({ id: 'hello', enabled: true, version: '0.1.0' });
    const issue = await cp.issueSetupToken(() => 'tok-abc');
    expect(issue).toEqual({ status: 'created', token: 'tok-abc' });
    await expect(cp.isSetupTokenValid('tok-abc')).resolves.toBe(true);
    await expect(cp.readRegistry()).resolves.toHaveLength(1);
  });

  it('upsert 收敛：同 id 重复注册刷新快照不重复建行；toggle 不存在的 id 回 null', async () => {
    const cp = SqliteControlPlane.open(':memory:');
    await cp.upsertModule({ id: 'hello', enabled: true, manifest: MANIFEST });
    await cp.upsertModule({ id: 'hello', enabled: false, manifest: { ...MANIFEST, version: '0.2.0' } });
    const rows = await cp.readRegistry();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ enabled: false, version: '0.2.0' });
    await expect(cp.toggleModule('ghost', true)).resolves.toBeNull();
    await expect(cp.toggleModule('hello', true)).resolves.toMatchObject({ enabled: true });
  });

  it('setup token 三态：created → reused → sealed（封箱后绝不签发）', async () => {
    const cp = SqliteControlPlane.open(':memory:');
    await expect(cp.issueSetupToken(() => 't1')).resolves.toEqual({ status: 'created', token: 't1' });
    await expect(cp.issueSetupToken(() => 't2')).resolves.toEqual({ status: 'reused', token: 't1' });
    // 封箱（写 instance_config 标记后，token 已有也不签发）
    cp.db.prepare("INSERT OR REPLACE INTO instance_config (key, value) VALUES ('setup_done', '1')").run();
    await expect(cp.issueSetupToken(() => 't3')).resolves.toEqual({ status: 'sealed' });
  });

  it('原子消费：并发双激活只有一次命中', async () => {
    const cp = SqliteControlPlane.open(':memory:');
    await cp.issueSetupToken(() => 'once');
    const [a, b] = await Promise.all([cp.consumeSetupToken('once', 'u1'), cp.consumeSetupToken('once', 'u2')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await expect(cp.consumeSetupToken('once', 'u3')).resolves.toBe(false);
  });

  it('按模块独立记账：同文件名跨模块互不可见（#55 护栏①）', async () => {
    const cp = SqliteControlPlane.open(':memory:');
    const files = [{ name: '0001_init.sql', sql: 'CREATE TABLE IF NOT EXISTS t (id TEXT);' }];
    const r1 = await cp.applyMigrations('alpha', files);
    expect(r1.applied).toEqual(['0001_init.sql']);
    // beta 同名文件必须重新执行——共享记账表会让它被误跳过（红灯点）
    const r2 = await cp.applyMigrations('beta', files);
    expect(r2.applied).toEqual(['0001_init.sql']);
    expect(r2.skipped).toEqual([]);
    // alpha 重跑 → 按记账跳过
    const r3 = await cp.applyMigrations('alpha', files);
    expect(r3.applied).toEqual([]);
    expect(r3.skipped).toEqual(['0001_init.sql']);
    // 表名隔离可见
    expect(migrationsTableFor('alpha')).toBe('unself_migrations_alpha');
    expect(migrationsTableFor('a-b')).toBe('unself_migrations_a_b');
    expect(() => migrationsTableFor('Bad!')).toThrow();
  });

  it('记账失败态：SQL 坏文件不记账，重跑整份重放（#55/modules.md 迁移契约）', async () => {
    const cp = SqliteControlPlane.open(':memory:');
    const report = await cp.applyMigrations('mod', [
      { name: '0001_ok.sql', sql: 'CREATE TABLE IF NOT EXISTS ok_t (id TEXT);' },
      { name: '0002_bad.sql', sql: 'THIS IS NOT SQL;' },
      { name: '0003_after.sql', sql: 'CREATE TABLE IF NOT EXISTS after_t (id TEXT);' },
    ]).catch(() => null);
    expect(report).toBeNull();
    // 坏文件未记账；0003 未执行；重跑给对的 SQL → 0002/0003 都执行
    const retry = await cp.applyMigrations('mod', [
      { name: '0001_ok.sql', sql: 'CREATE TABLE IF NOT EXISTS ok_t (id TEXT);' },
      { name: '0002_bad.sql', sql: 'CREATE TABLE IF NOT EXISTS fixed_t (id TEXT);' },
      { name: '0003_after.sql', sql: 'CREATE TABLE IF NOT EXISTS after_t (id TEXT);' },
    ]);
    expect(retry.applied).toEqual(['0002_bad.sql', '0003_after.sql']);
    expect(retry.skipped).toEqual(['0001_ok.sql']);
  });
});

describe('D1ControlPlane（同一份 SQL 跑在 D1 形状适配器上）', () => {
  /** 真 sqlite 包一层 D1 形状（不带 RETURNING 之外的额外语义），验证 SQL 单点可移植。 */
  function d1OverSqlite(cp: SqliteControlPlane): D1ControlPlane {
    const db = cp.db;
    return new D1ControlPlane({
      prepare(sql: string) {
        // node:sqlite 原生支持 ?N 序号占位符按位置绑定（与 D1 同语义），无需改写 SQL
        const stmt = db.prepare(sql);
        return {
          bind(...values: unknown[]) {
            return {
              first: async <T>() => (stmt.get(...(values as never[])) ?? null) as T | null,
              all: async <T>() => ({ results: stmt.all(...(values as never[])) as T[] }),
              run: async () => ({ meta: { changes: Number(stmt.run(...(values as never[])).changes) } }),
            };
          },
        };
      },
    });
  }

  it('upsert / toggle / readRegistry 与 sqlite 实现同语义（防漂移）', async () => {
    const base = SqliteControlPlane.open(':memory:');
    const cp = d1OverSqlite(base);
    const entry = await cp.upsertModule({ id: 'hello', enabled: true, manifest: MANIFEST });
    expect(entry).toMatchObject({ id: 'hello', enabled: true, version: '0.1.0' });
    await cp.upsertModule({ id: 'hello', enabled: false, manifest: { ...MANIFEST, version: '0.3.0' } });
    const rows = await cp.readRegistry();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ enabled: false, version: '0.3.0' });
    expect(await cp.toggleModule('hello', true)).toMatchObject({ enabled: true });
    expect(await cp.toggleModule('ghost', true)).toBeNull();
  });
});

describe('node:sqlite 友好探测', () => {
  it('本机可用：usable=true 且报告版本；探测函数在正常机不抛', () => {
    const probe = probeSqlite();
    if (probe.usable) {
      expect(probe.version).toMatch(/^\d+\.\d+\.\d+/);
    } else {
      // 低版本 Node 的 CI：reason 必须是含 flag 提示的人话，不是堆栈
      expect(probe.reason).toContain('--experimental-sqlite');
    }
  });
});
