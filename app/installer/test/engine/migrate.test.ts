// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 两值落点 + 迁移契约测试（#248/#349 U5，决策 #55/#61）：
 * - storageLevelFor：declaration → preferred → self 的缺省链（undefined = self）；
 * - checkSharedGuards：申报/跨模块外键护栏（专属库库级隔离，前缀不再是硬规则）；
 * - migrationFailure：模块/文件/第几条语句 三要素定位；
 * - SqliteControlPlane.applyMigrations：同名 0001 跨模块记账隔离（护栏①）。
 *   ——红灯锚点：把记账表改回共用（applyMigrations('core', …) 用同名文件）→ 该组必红。
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { SqliteControlPlane } from '@unself/control-plane';
import {
  checkSharedGuards,
  dedicatedDbNameFor,
  doMigrationLedgerName,
  foreignKeyTargets,
  migrationDirFor,
  migrationFailure,
  planDoMigrations,
  storageLevelFor,
  tablePrefixFor,
} from '../../src/engine/migrate';

describe('migrationDirFor（#349 U5：core 自建表恒用 <id>/）', () => {
  it('恒用 migrations/<id>/（shared 前缀集已废除）', async () => {
    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'unself-migdir-'));
    await mkdir(join(dir, 'migrations', 'demo'), { recursive: true });
    expect(migrationDirFor(dir, 'demo')).toBe(join(dir, 'migrations', 'demo'));
  });
});

describe('storageLevelFor（#55 → #349 U5 两值缺省链）', () => {
  const M = (storage?: unknown) => ({ manifest: storage ? { storage } : undefined, id: 'demo' }) as Parameters<typeof storageLevelFor>[0];

  it('declaration 优先；缺省 preferred；再缺省 self（undefined = self）', () => {
    expect(storageLevelFor(M({ declaration: 'self', preferred: 'core' }))).toBe('self');
    expect(storageLevelFor(M({ preferred: 'core' }))).toBe('core');
    expect(storageLevelFor(M(undefined))).toBe('self');
    expect(storageLevelFor(M({ accepts: ['core', 'self'] }))).toBe('self');
  });
});

describe('checkSharedGuards（#55 → #349 U5 护栏：申报 + 跨模块外键；专属库库级隔离，前缀不是硬规则）', () => {
  it('合规：清单内互引（表名不带前缀，原 dedicated 形态零迁移）→ 零问题', () => {
    const problems = checkSharedGuards({
      moduleId: 'demo',
      tables: ['items', 'tags'],
      migrations: [
        { name: '0001_init.sql', sql: 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY);' },
        {
          name: '0002_tags.sql',
          sql: 'CREATE TABLE IF NOT EXISTS tags (item_id INTEGER, FOREIGN KEY (item_id) REFERENCES items);',
        },
      ],
    });
    expect(problems).toEqual([]);
  });

  it('建了未申报的表 → 报问题（core 库不接收未经申报的表）', () => {
    const problems = checkSharedGuards({
      moduleId: 'demo',
      tables: ['demo_items'],
      migrations: [
        {
          name: '0001_init.sql',
          sql: 'CREATE TABLE IF NOT EXISTS demo_items (id INTEGER);\nCREATE TABLE IF NOT EXISTS demo_secret (id INTEGER);',
        },
      ],
    });
    expect(problems.some((p) => p.includes('demo_secret') && p.includes('申报'))).toBe(true);
  });

  it('外键引用他人模块的表 → 报问题（禁止跨模块外键）', () => {
    const problems = checkSharedGuards({
      moduleId: 'demo',
      tables: ['demo_items'],
      migrations: [
        {
          name: '0001_init.sql',
          sql: 'CREATE TABLE IF NOT EXISTS demo_items (other_id INTEGER, FOREIGN KEY (other_id) REFERENCES other_module_table);',
        },
      ],
    });
    expect(problems.some((p) => p.includes('other_module_table') && p.includes('外键'))).toBe(true);
  });

  it('foreignKeyTargets：抓 REFERENCES 目标（含引号形态）', () => {
    expect(foreignKeyTargets('FOREIGN KEY (a) REFERENCES demo_items(id), FOREIGN KEY (b) REFERENCES "demo_tags"')).toEqual([
      'demo_items',
      'demo_tags',
    ]);
  });

  it('tablePrefixFor / dedicatedDbNameFor 命名约定', () => {
    expect(tablePrefixFor('my-mod')).toBe('my_mod_');
    expect(dedicatedDbNameFor('my-mod')).toBe('unself-my-mod');
  });
});

describe('planDoMigrations（#255：DO 迁移判定 = 记账事实，不是脚本存在与否）', () => {
  const CHAT = [{ tag: 'v1', new_sqlite_classes: ['ChannelRoom', 'Scheduler', 'UserInbox'] }];
  const APPLIED = (tags: string[]) => tags.map((t) => doMigrationLedgerName(t));

  it('未记账（含「脚本已存在但类未建」的 stub 场景）→ 必须发迁移：无 oldTag、newTag=v1、三类各一步', () => {
    const plan = planDoMigrations({ declared: CHAT, appliedNames: [] });
    expect(plan).toEqual({
      newTag: 'v1',
      steps: [{ new_sqlite_classes: ['ChannelRoom', 'Scheduler', 'UserInbox'] }],
      tags: ['v1'],
    });
    // stub 场景的记账态与「记账表里只有 SQL 文件」等价（没有 do-migration 条目）：照样发
    expect(planDoMigrations({ declared: CHAT, appliedNames: ['0001_baseline.sql'] })).toBeDefined();
  });

  it('tag 已记账 → 不发（幂等重传不带 migrations；重复 tag 会被 CF 拒，10079）', () => {
    expect(planDoMigrations({ declared: CHAT, appliedNames: [...APPLIED(['v1']), '0001_baseline.sql'] })).toBeUndefined();
  });

  it('多 tag：待应用从第一个未记账开始，oldTag=前一个已记账，steps 按声明序累积', () => {
    const declared = [
      { tag: 'v1', new_sqlite_classes: ['A'] },
      { tag: 'v2', new_sqlite_classes: ['B'] },
      { tag: 'v3', new_sqlite_classes: ['C'] },
    ];
    expect(planDoMigrations({ declared, appliedNames: APPLIED(['v1']) })).toEqual({
      oldTag: 'v1',
      newTag: 'v3',
      steps: [{ new_sqlite_classes: ['B'] }, { new_sqlite_classes: ['C'] }],
      tags: ['v2', 'v3'],
    });
    expect(planDoMigrations({ declared, appliedNames: APPLIED(['v1', 'v2']) })).toEqual({
      oldTag: 'v2',
      newTag: 'v3',
      steps: [{ new_sqlite_classes: ['C'] }],
      tags: ['v3'],
    });
    expect(planDoMigrations({ declared, appliedNames: APPLIED(['v1', 'v2', 'v3']) })).toBeUndefined();
  });

  it('记账夹缝（后一个已记、前一个未记）→ 停住报出具体 tag，不静默续跑', () => {
    const declared = [
      { tag: 'v1', new_sqlite_classes: ['A'] },
      { tag: 'v2', new_sqlite_classes: ['B'] },
    ];
    expect(() => planDoMigrations({ declared, appliedNames: APPLIED(['v2']) })).toThrow(/v2/);
  });

  it('未声明任何 DO 迁移 → undefined（普通模块不受影响）', () => {
    expect(planDoMigrations({ declared: [], appliedNames: [] })).toBeUndefined();
  });
});

describe('migrationFailure（#61：模块 / 文件 / 第几条语句）', () => {
  const sql = 'CREATE TABLE IF NOT EXISTS demo_a (id INTEGER);\nCREATE TABLE demo_b (id INTEGER);';

  it('错误消息含模块 id、文件名与语句序号；不自动重试不回滚明示', () => {
    const err = migrationFailure({ moduleId: 'demo', file: '0002_x.sql', sql, cause: new Error('near "demo_b": syntax error') });
    expect(err.message).toContain('模块 demo');
    expect(err.message).toContain('0002_x.sql');
    expect(err.message).toContain('第 2 条语句');
    expect(err.message).toContain('不自动重试');
  });

  it('定位不到语句时也不糊弄：给出总数', () => {
    const err = migrationFailure({ moduleId: 'demo', file: '0001_init.sql', sql, cause: new Error('database disk I/O error') });
    expect(err.message).toContain('共 2 条');
  });
});

describe('记账隔离（#55 护栏①，红灯锚点）', () => {
  it('两个模块各有同名 0001_init.sql：各记各的账，第二次安装不互相跳过', async () => {
    const cp = new SqliteControlPlane(new DatabaseSync(':memory:'));
    const modA = [{ name: '0001_init.sql', sql: 'CREATE TABLE IF NOT EXISTS a_items (id INTEGER);' }];
    const modB = [{ name: '0001_init.sql', sql: 'CREATE TABLE IF NOT EXISTS b_items (id INTEGER);' }];

    const r1 = await cp.applyMigrations('mod-a', modA);
    const r2 = await cp.applyMigrations('mod-b', modB);
    // 记账表隔离：同名文件在两个模块各自独立记账、各自真正执行
    expect(r1.applied).toEqual(['0001_init.sql']);
    expect(r2.applied).toEqual(['0001_init.sql']);
    expect(await cp.appliedMigrations('mod-a')).toEqual(['0001_init.sql']);
    expect(await cp.appliedMigrations('mod-b')).toEqual(['0001_init.sql']);
    // 重跑同一模块：按各自记账跳过（幂等）
    expect((await cp.applyMigrations('mod-a', modA)).skipped).toEqual(['0001_init.sql']);
    expect((await cp.applyMigrations('mod-b', modB)).skipped).toEqual(['0001_init.sql']);
  });

  it('红灯复现：共用一条记账（同一模块名）时，mod-b 的 0001 被 mod-a 的记账跳过——这就是被隔离掉的旧病灶', async () => {
    const cp = new SqliteControlPlane(new DatabaseSync(':memory:'));
    const modA = [{ name: '0001_init.sql', sql: 'CREATE TABLE IF NOT EXISTS a_items (id INTEGER);' }];
    const modB = [{ name: '0001_init.sql', sql: 'CREATE TABLE IF NOT EXISTS b_items (id INTEGER);' }];
    await cp.applyMigrations('shared-ledger', modA);
    // 同一模块名再装「另一个模块」的同名文件 → 被跳过（bug 形态）。本用例锁定该 bug 形态存在过：
    const skipped = (await cp.applyMigrations('shared-ledger', modB)).skipped;
    expect(skipped).toEqual(['0001_init.sql']);
    // 隔离后（各自模块名）则如上一用例：双方都 applied。
  });
});
