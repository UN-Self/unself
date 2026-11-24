// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ControlPlane 行为测试（真 SQLite，不测实现）：
 * 同一份 SQL 跑在 sqlite 实现上，验证注册表收敛 / setup token 三态 / 原子消费 /
 * 按模块独立记账（#55 护栏①）/ node:sqlite 友好探测。
 * 两问检验：把 upsert 改成「不收敛」（如 INSERT 无 ON CONFLICT）必红；
 * 把记账表改成全局共享（同表）必红；落点三列改回覆盖式（excluded.x 直赋）必红（#348 review）。
 */
import { describe, expect, it } from 'vitest';
import { D1ControlPlane } from '../src/d1';
import { RestD1ControlPlane } from '../src/rest';
import { SqliteControlPlane } from '../src/sqlite';
import { probeSqlite } from '../src/sqlite-probe';
import { defineControlPlaneContract } from './control-plane-cases';

const MANIFEST = { id: 'hello', version: '0.1.0', entry: '/m/hello/', runtime: 'worker' };

defineControlPlaneContract('SqliteControlPlane（真 sqlite）', async () => {
  const cp = SqliteControlPlane.open(':memory:');
  return {
    cp,
    seal: async () => {
      cp.db.prepare("INSERT OR REPLACE INTO instance_config (key, value) VALUES ('setup_done', '1')").run();
    },
    reset: async () => {},
    close: async () => {
      cp.db.close();
    },
  };
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

describe('RestD1ControlPlane（同一份 SQL 跑在 REST 执行器上 · 防漂移）', () => {
  /** 真 sqlite 包一层 REST 执行器形状（query + importSql）。 */
  function restOverSqlite(cp: SqliteControlPlane) {
    const db = cp.db;
    return new RestD1ControlPlane({
      async query<T>(sql: string, params: unknown[] = []) {
        const stmt = db.prepare(sql);
        if (/^\s*(select|with|pragma)/i.test(sql)) {
          const rows = (stmt.all(...(params as never[])) as T[]).map((r) => ({ ...r }) as T);
          return { results: rows, meta: { changes: 0 } };
        }
        const info = stmt.run(...(params as never[]));
        // RETURNING：回读取结果
        if (/\breturning\b/i.test(sql)) {
          const rows = (stmt.all(...(params as never[])) as T[]).map((r) => ({ ...r }) as T);
          return { results: rows, meta: { changes: Number(info.changes) } };
        }
        return { results: [], meta: { changes: Number(info.changes) } };
      },
      async importSql(sqlText: string) {
        db.exec(sqlText);
        return { numQueries: sqlText.split(';').length - 1 };
      },
    });
  }

  it('注册表 upsert/toggle/list + setup token 三态与 sqlite 实现同语义', async () => {
    const base = SqliteControlPlane.open(':memory:');
    const cp = restOverSqlite(base);
    const entry = await cp.upsertModule({ id: 'hello', enabled: true, manifest: MANIFEST });
    expect(entry).toMatchObject({ id: 'hello', enabled: true, version: '0.1.0' });
    await cp.upsertModule({ id: 'hello', enabled: false, manifest: { ...MANIFEST, version: '0.4.0' } });
    const rows = await cp.readRegistry();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ enabled: false, version: '0.4.0' });
    await expect(cp.toggleModule('ghost', true)).resolves.toBeNull();
    await expect(cp.toggleModule('hello', true)).resolves.toMatchObject({ enabled: true });
    await expect(cp.issueSetupToken(() => 'rt1')).resolves.toEqual({ status: 'created', token: 'rt1' });
    await expect(cp.issueSetupToken(() => 'rt2')).resolves.toEqual({ status: 'reused', token: 'rt1' });
    await expect(cp.consumeSetupToken('rt1', 'u1')).resolves.toBe(true);
    await expect(cp.isSetupTokenValid('rt1')).resolves.toBe(false);
  });

  it('迁移记账：按模块独立 + 失败文件不记账 + 老库 d1_migrations 预置对齐（不重放老文件）', async () => {
    const base = SqliteControlPlane.open(':memory:');
    // 模拟 wrangler 时代老库：d1_migrations 已记 0001_init.sql
    base.db.exec('CREATE TABLE d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT)');
    base.db.prepare("INSERT INTO d1_migrations (name) VALUES ('0001_init.sql')").run();
    const cp = restOverSqlite(base);
    const files = [
      { name: '0001_init.sql', sql: 'CREATE TABLE IF NOT EXISTS legacy_t (id TEXT);' },
      { name: '0002_new.sql', sql: 'CREATE TABLE IF NOT EXISTS new_t (id TEXT);' },
    ];
    const report = await cp.applyMigrations('hello', files);
    expect(report.skipped).toEqual(['0001_init.sql']); // 老文件按老账跳过（升级链不重放）
    expect(report.applied).toEqual(['0002_new.sql']);
    // 再跑 → 全跳过；另一个模块同名文件不跳过（隔离不因预置而破坏）
    const again = await cp.applyMigrations('hello', files);
    expect(again.applied).toEqual([]);
    const other = await cp.applyMigrations('chat', files);
    expect(other.skipped).toEqual(['0001_init.sql']);
    expect(other.applied).toEqual(['0002_new.sql']);
  });

  it('非 SQL 迁移事件（DO 迁移 tag）与文件记账同表：REST 实现与 sqlite 实现同语义（#255）', async () => {
    const base = SqliteControlPlane.open(':memory:');
    const cp = restOverSqlite(base);
    await cp.applyMigrations('chat', [{ name: '0001_baseline.sql', sql: 'CREATE TABLE IF NOT EXISTS t (id TEXT);' }]);
    await cp.markMigrationApplied('chat', 'do-migration:v1');
    await cp.markMigrationApplied('chat', 'do-migration:v1');
    await expect(cp.appliedMigrations('chat')).resolves.toEqual(['0001_baseline.sql', 'do-migration:v1']);
    // REST 写入的是同一张表：直查底库可见（不是另建的表）
    const rows = base.db.prepare('SELECT name FROM unself_migrations_chat ORDER BY name').all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(['0001_baseline.sql', 'do-migration:v1']);
  });
});
