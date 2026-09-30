// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import { CONTRACT_VERSION, ModuleManifestSchema } from '../src/manifest';
import { manifestFromYamlText, validateModulePackage } from '../src/validate';
import { findRepoRoot } from './helpers/repo-root';

/** 仓库根（core/contracts → 上两级）。 */
const REPO_ROOT = findRepoRoot();

/** 读官方模块真实文件（验收：官方 hello/chat 以仓库真实文件过 validate）。 */
function readRepoFile(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), 'utf8');
}

/** hello 官方模块包输入（manifest.json 形态由 manifest.yaml v1 迁移而来；入口指向 worker 产物）。 */
function helloPackageInput(): {
  manifestText: string;
  packageName: string;
  workerText?: string;
  licenseText: string;
  migrations?: Record<string, string>;
} {
  const manifest = {
    id: 'hello',
    version: '0.1.0',
    runtimes: ['worker'],
    route: '/m/hello',
    entry: 'https://team.example.com/m/hello/',
    description: 'hello world 演示模块：SDK 存储计数器',
    permissions: ['storage'],
  };
  return {
    manifestText: JSON.stringify(manifest, null, 2) + '\n',
    packageName: 'hello',
    workerText: 'export default {}',
    licenseText: readRepoFile('LICENSE'),
  };
}

/** chat 官方模块包输入：tables 申报 = migrations/chat/0001_baseline.sql 的 18 张表（与迁移一致）。 */
function chatPackageInput(): {
  manifestText: string;
  packageName: string;
  workerText?: string;
  licenseText: string;
  migrations: Record<string, string>;
} {
  const manifest = {
    id: 'chat',
    version: '0.1.0',
    runtimes: ['worker'],
    route: '/m/chat',
    entry: 'https://team.example.com/m/chat/',
    description: 'EdgeChat：频道聊天模块',
    permissions: ['storage', 'notify'],
    storage: { accepts: ['dedicated'], preferred: 'dedicated' },
    tables: [
      'users',
      'channels',
      'channel_members',
      'messages',
      'user_blocks',
      'channel_pins',
      'message_reads',
      'site_settings',
      'registration_invites',
      'registration_invite_uses',
      'uploaded_files',
      'device_sessions',
      'realtime_tickets',
      'message_events',
      'message_event_compaction',
      'pending_r2_delete',
      'core_identities',
      'read_receipts',
    ],
  };
  return {
    manifestText: JSON.stringify(manifest, null, 2) + '\n',
    packageName: 'chat',
    workerText: 'export default {}',
    licenseText: 'SPDX-License-Identifier: GPL-3.0-only',
    migrations: {
      '0001_baseline.sql': readRepoFile('app/modules/chat/migrations/chat/0001_baseline.sql'),
    },
  };
}

/** 合法最小包。 */
function minimalInput(): Parameters<typeof validateModulePackage>[0] {
  return {
    manifestText: JSON.stringify({
      id: 'todo',
      version: '1.0.0',
      runtimes: ['worker'],
      route: '/m/todo',
      entry: 'https://team.example.com/m/todo/',
    }),
    packageName: 'todo',
    workerText: 'export default {}',
    licenseText: 'MIT',
  };
}

describe('validateModulePackage：绿路径', () => {
  it('最小合法包通过（core 级、无 permissions、无 storage）', () => {
    const result = validateModulePackage(minimalInput());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('官方 hello 通过 validate（真实 LICENSE；permissions=[storage]）', () => {
    const result = validateModulePackage(helloPackageInput());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('官方 chat 通过 validate（真实 0001_baseline.sql，18 张表申报一致）', () => {
    const result = validateModulePackage(chatPackageInput());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('compat 覆盖当前契约版本时通过', () => {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.compat = { min: '0.9', max: '1.0' };
    const result = validateModulePackage({ ...base, manifestText: JSON.stringify(manifest) });
    expect(result.ok).toBe(true);
  });
});

describe('护栏③与真 SQLite 对照（#310 实测退回：括号/注释形态漏检）', () => {
  function sharedPkgWith(migrationSql: string): Parameters<typeof validateModulePackage>[0] {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.storage = { accepts: ['shared'] };
    manifest.tablesShared = ['todo_items'];
    return { ...base, manifestText: JSON.stringify(manifest), migrations: { '0001_init.sql': migrationSql } };
  }

  it('REFERENCES [foreign_table] → 真库建出跳模块 FK，validate 必须拒绝', () => {
    const sql =
      'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY, f INTEGER REFERENCES [foreign_table](id));';
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS [foreign_table] (id INTEGER PRIMARY KEY);');
    db.exec(sql);
    const fk = db
      .prepare("SELECT \"table\" AS t FROM pragma_foreign_key_list('todo_items')")
      .all() as Array<{ t: string }>;
    expect(fk.map((r) => r.t)).toEqual(['foreign_table']);
    db.close();

    const result = validateModulePackage(sharedPkgWith(sql));
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.check === 'tables' && e.message.includes('foreign_table') && e.message.includes('外键')),
    ).toBe(true);
  });

  it('REFERENCES /* comment */ foreign_table → 真库建出 FK，validate 必须拒绝', () => {
    const sql =
      'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY, f INTEGER REFERENCES /* explanatory comment */ foreign_table(id));';
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS foreign_table (id INTEGER PRIMARY KEY);');
    db.exec(sql);
    const fk = db
      .prepare("SELECT \"table\" AS t FROM pragma_foreign_key_list('todo_items')")
      .all() as Array<{ t: string }>;
    expect(fk.map((r) => r.t)).toEqual(['foreign_table']);
    db.close();

    const result = validateModulePackage(sharedPkgWith(sql));
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.check === 'tables' && e.message.includes('foreign_table') && e.message.includes('外键')),
    ).toBe(true);
  });

  it('括号引号的本模块内引用（[todo_items]）→ 真库可建、validate 通过', () => {
    const sql =
      'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY, p INTEGER REFERENCES [todo_items](id));';
    const db = new DatabaseSync(':memory:');
    db.exec(sql);
    const fk = db
      .prepare("SELECT \"table\" AS t FROM pragma_foreign_key_list('todo_items')")
      .all() as Array<{ t: string }>;
    expect(fk.map((r) => r.t)).toEqual(['todo_items']);
    db.close();

    const result = validateModulePackage(sharedPkgWith(sql));
    expect(result.errors.filter((e) => e.check === 'tables')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('CREATE TABLE IF NOT EXISTS [foreign_table] 不再被认成表名 IF', () => {
    const result = validateModulePackage(
      sharedPkgWith('CREATE TABLE IF NOT EXISTS [todo_items] (id INTEGER PRIMARY KEY);'),
    );
    // 建表名解析为 todo_items（在申报清单内）→ 无“未申报的表 IF”之类误报
    expect(result.errors.some((e) => e.message.includes('IF'))).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("REFERENCES 'foreign_table'（单引号）→ 真库建出跳模块 FK，validate 必须拒绝", () => {
    const sql =
      "CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY, f INTEGER REFERENCES 'foreign_table'(id));";
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS [foreign_table] (id INTEGER PRIMARY KEY);');
    db.exec(sql);
    const fk = db.prepare("SELECT \"table\" AS t FROM pragma_foreign_key_list('todo_items')").all() as Array<{ t: string }>;
    expect(fk.map((r) => r.t)).toEqual(['foreign_table']);
    db.close();

    const result = validateModulePackage(sharedPkgWith(sql));
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.check === 'tables' && e.message.includes('foreign_table') && e.message.includes('外键')),
    ).toBe(true);
  });

  it('列名是含 -- 的双引号标识符时，其后的跨模块 REFERENCES 不被吞掉', () => {
    const sql =
      'CREATE TABLE IF NOT EXISTS todo_items ("-- harmless column" INTEGER, f INTEGER REFERENCES foreign_table(id));';
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS foreign_table (id INTEGER PRIMARY KEY);');
    db.exec(sql);
    const fk = db.prepare("SELECT \"table\" AS t FROM pragma_foreign_key_list('todo_items')").all() as Array<{ t: string }>;
    expect(fk.map((r) => r.t)).toEqual(['foreign_table']);
    db.close();

    const result = validateModulePackage(sharedPkgWith(sql));
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.check === 'tables' && e.message.includes('foreign_table') && e.message.includes('外键')),
    ).toBe(true);
  });

  it("CREATE TABLE 'todo_items'（不支持的真实语法）→ 显式拒绝，不静默跳过", () => {
    const result = validateModulePackage(sharedPkgWith("CREATE TABLE 'todo_items' (id INTEGER);"));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.check === 'tables' && e.message.includes('CREATE TABLE'))).toBe(true);
  });

  it('REFERENCES todo_items外（Unicode 标识符不得截断为已申报 todo_items）→ 真库 FK 指向未申报表，validate 拒绝', () => {
    const sql =
      'CREATE TABLE IF NOT EXISTS todo_items外 (id INTEGER PRIMARY KEY);\n' +
      'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER, f INTEGER REFERENCES todo_items外(id));';
    const db = new DatabaseSync(':memory:');
    db.exec(sql);
    const fk = db
      .prepare("SELECT \"table\" AS t FROM pragma_foreign_key_list('todo_items')")
      .all() as Array<{ t: string }>;
    expect(fk.map((r) => r.t)).toEqual(['todo_items外']);
    db.close();

    const result = validateModulePackage(sharedPkgWith(sql));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes('todo_items外'))).toBe(true);
  });

  it('CREATE VIRTUAL TABLE（fts5 影子表）→ 未支持必显式拒绝，不静默跳过', () => {
    const sql =
      'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY);\n' +
      'CREATE VIRTUAL TABLE IF NOT EXISTS foreign_search USING fts5(content);';
    const db = new DatabaseSync(':memory:');
    db.exec(sql);
    const created = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'foreign_search%'")
      .all() as Array<{ name: string }>;
    // 真库确实建了 foreign_search + 影子表（>1）
    expect(created.length).toBeGreaterThan(1);
    db.close();

    const result = validateModulePackage(sharedPkgWith(sql));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.check === 'tables' && e.message.includes('虚拟表'))).toBe(true);
  });
});

describe('六类硬错（docs/modules.md §7，每类红灯）', () => {
  it('① id 不合法 / 与包名不一致 → error(id)', () => {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.id = 'Todo';
    const bad = validateModulePackage({ ...base, manifestText: JSON.stringify(manifest) });
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => e.check)).toContain('id');

    const mismatch = validateModulePackage({ ...minimalInput(), packageName: 'other-name' });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.map((e) => e.check)).toContain('id');
  });

  it('② storage.accepts 与实现用法不符（带 migrations 却只声明 core）→ error(storage)', () => {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.storage = { accepts: ['core'] };
    const result = validateModulePackage({
      ...base,
      manifestText: JSON.stringify(manifest),
      migrations: { '0001_init.sql': 'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY);' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.check)).toContain('storage');
  });

  it('③ tables 与迁移不一致（建了未申报 / 申报未建）→ error(tables)', () => {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.storage = { accepts: ['shared'], declaration: 'shared' };
    manifest.tablesShared = ['todo_items'];
    const undeclared = validateModulePackage({
      ...base,
      manifestText: JSON.stringify(manifest),
      migrations: {
        '0001_init.sql': 'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY);\nCREATE TABLE todo_extra (id INTEGER);',
      },
    });
    expect(undeclared.ok).toBe(false);
    expect(undeclared.errors.some((e) => e.check === 'tables' && e.message.includes('todo_extra'))).toBe(true);

    manifest.tablesShared = ['todo_items', 'todo_ghost'];
    const ghost = validateModulePackage({
      ...base,
      manifestText: JSON.stringify(manifest),
      migrations: { '0001_init.sql': 'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY);' },
    });
    expect(ghost.ok).toBe(false);
    expect(ghost.errors.some((e) => e.message.includes('todo_ghost'))).toBe(true);
  });

  it('④ 缺 LICENSE → error(license)', () => {
    const base = minimalInput();
    const result = validateModulePackage({ ...base, licenseText: undefined });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.check)).toContain('license');
  });

  it('⑤ 未知 capability → error(permissions)（schema 层拒绝 + 人话诊断）', () => {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.permissions = ['storage', 'chat'];
    const result = validateModulePackage({ ...base, manifestText: JSON.stringify(manifest) });
    expect(result.ok).toBe(false);
    const permissionError = result.errors.find((e) => e.check === 'permissions');
    expect(permissionError).toBeDefined();
    expect(permissionError?.message).toContain('permissions');
  });

  it('⑥ compat 不匹配（min 高于 / max 低于当前契约版本）→ error(compat)', () => {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.compat = { min: '2.0', max: '2.1' };
    const tooNew = validateModulePackage({ ...base, manifestText: JSON.stringify(manifest) });
    expect(tooNew.ok).toBe(false);
    expect(tooNew.errors.map((e) => e.check)).toContain('compat');

    manifest.compat = { min: '0.1', max: '0.9' };
    const tooOld = validateModulePackage({ ...base, manifestText: JSON.stringify(manifest) });
    expect(tooOld.ok).toBe(false);
    expect(tooOld.errors.map((e) => e.check)).toContain('compat');
  });
});

describe('增量友好（#57）与附加检查', () => {
  it('未知字段 → warning 不拦人', () => {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.tagline = '未来字段';
    const result = validateModulePackage({ ...base, manifestText: JSON.stringify(manifest) });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.message).join('\n')).toContain('tagline');
  });

  it('runtimes 含 worker 但缺 worker.js → error(entry)', () => {
    const base = minimalInput();
    const result = validateModulePackage({ ...base, workerText: undefined });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.check)).toContain('entry');
  });

  it('迁移文件名不符合 000N_描述.sql → error(tables)', () => {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.storage = { accepts: ['shared'], declaration: 'shared' };
    manifest.tablesShared = ['todo_items'];
    const result = validateModulePackage({
      ...base,
      manifestText: JSON.stringify(manifest),
      migrations: { 'init.sql': 'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER);' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes('init.sql'))).toBe(true);
  });

  it('manifest 不是合法 JSON → error(schema)', () => {
    const result = validateModulePackage({ ...minimalInput(), manifestText: '{nope' });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.check)).toContain('schema');
  });
});

describe('护栏③（决策 #55）：shared 前缀 + 禁跨模块外键——发布期与装配期同一份实现', () => {
  function sharedPkg(
    manifestPatch: Record<string, unknown>,
    migrations: Record<string, string>,
  ): Parameters<typeof validateModulePackage>[0] {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    Object.assign(manifest, manifestPatch);
    return { ...base, manifestText: JSON.stringify(manifest), migrations };
  }

  it('accepts 含 shared 但迁移表名无模块前缀 → error(tables)，点名缺失前缀', () => {
    const result = validateModulePackage(sharedPkg(
      { storage: { accepts: ['shared'] }, tablesShared: ['todo_items'] },
      { '0001_init.sql': 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY);' },
    ));
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.check === 'tables' && e.message.includes('items') && e.message.includes('todo_')),
    ).toBe(true);
  });

  it('accepts 含 shared 且外键指向清单之外的表 → error(tables)，点名跨模块外键', () => {
    const result = validateModulePackage(sharedPkg(
      { storage: { accepts: ['shared'] }, tablesShared: ['todo_items'] },
      {
        '0001_init.sql':
          'CREATE TABLE IF NOT EXISTS todo_items (other_id INTEGER, FOREIGN KEY (other_id) REFERENCES other_module_table);',
      },
    ));
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.check === 'tables' && e.message.includes('other_module_table') && e.message.includes('外键'),
      ),
    ).toBe(true);
  });

  it('合规 shared 包（前缀 + 模块内互引）→ 护栏③零报错', () => {
    const result = validateModulePackage(sharedPkg(
      { storage: { accepts: ['shared'] }, tablesShared: ['todo_items', 'todo_tags'] },
      {
        '0001_init.sql': 'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY);',
        '0002_tags.sql': 'CREATE TABLE IF NOT EXISTS todo_tags (item_id INTEGER, FOREIGN KEY (item_id) REFERENCES todo_items);',
      },
    ));
    expect(result.errors.filter((e) => e.check === 'tables')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('纯 dedicated 模块不受前缀约束（护栏③只针对 shared）→ 无前缀也不报护栏', () => {
    const result = validateModulePackage(sharedPkg(
      { storage: { accepts: ['dedicated'], preferred: 'dedicated' }, tables: ['items'] },
      { '0001_init.sql': 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY);' },
    ));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('迁移静态检查（决策 #61，#248）：逐条幂等 + 只写增量安全语句', () => {
  /** shared 级合法最小包（带迁移入口）。 */
  function sharedInput(migrations: Record<string, string>): Parameters<typeof validateModulePackage>[0] {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.storage = { accepts: ['shared'], declaration: 'shared' };
    manifest.tablesShared = ['todo_items'];
    return { ...base, manifestText: JSON.stringify(manifest), migrations };
  }

  it('全幂等增量迁移 → 绿（官方 hello 真实文件同规）', () => {
    const result = validateModulePackage(sharedInput({
      '0001_init.sql': 'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY);\nCREATE INDEX IF NOT EXISTS idx_todo ON todo_items (id);',
      '0002_seed.sql': "INSERT OR IGNORE INTO todo_items (id) VALUES (1);",
    }));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('非幂等 CREATE（缺 IF NOT EXISTS）→ error 指出文件与第几条语句', () => {
    const result = validateModulePackage(sharedInput({
      '0001_init.sql': 'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY);\nCREATE TABLE todo_tags (id INTEGER);',
    }));
    expect(result.ok).toBe(false);
    const mig = result.errors.filter((e) => e.check === 'migrations');
    expect(mig).toHaveLength(1);
    expect(mig[0]!.message).toContain('0001_init.sql');
    expect(mig[0]!.message).toContain('第 2 条');
    expect(mig[0]!.message).toContain('IF NOT EXISTS');
  });

  it('非幂等 INSERT（缺 OR IGNORE/REPLACE）→ error 指出文件与第几条语句', () => {
    const result = validateModulePackage(sharedInput({
      '0001_init.sql': 'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY);',
      '0002_seed.sql': "INSERT INTO todo_items (id) VALUES (1);",
    }));
    expect(result.ok).toBe(false);
    const mig = result.errors.filter((e) => e.check === 'migrations');
    expect(mig).toHaveLength(1);
    expect(mig[0]!.message).toContain('0002_seed.sql');
    expect(mig[0]!.message).toContain('第 1 条');
    expect(mig[0]!.message).toContain('OR IGNORE');
  });

  it('破坏性语句（DROP/DELETE/UPDATE/ALTER）→ error 拦下（增量安全规则②）', () => {
    const result = validateModulePackage(sharedInput({
      '0001_init.sql': 'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY);',
      '0002_drop.sql': 'DROP TABLE todo_items;',
      '0003_wipe.sql': 'DELETE FROM todo_items;',
      '0004_rewrite.sql': 'UPDATE todo_items SET id = 1;',
      '0005_expand.sql': 'ALTER TABLE todo_items ADD COLUMN title TEXT;',
    }));
    expect(result.ok).toBe(false);
    const mig = result.errors.filter((e) => e.check === 'migrations');
    // DROP/DELETE/UPDATE/ALTER 各一条；CREATE 幂等不报
    expect(mig).toHaveLength(4);
    expect(mig.map((e) => e.message).map((m) => m.split('：')[0])).toEqual([
      '0002_drop.sql',
      '0003_wipe.sql',
      '0004_rewrite.sql',
      '0005_expand.sql',
    ]);
    expect(mig[0]!.message).toContain('第 1 条');
  });

  it('触发器体内分号不切语句；官方 chat 真实 0001_baseline.sql 幂等检查全绿', () => {
    const result = validateModulePackage({ ...chatPackageInput() });
    // chat 的 baseline 全部 CREATE IF NOT EXISTS / INSERT OR IGNORE → 幂等检查零新增错误
    expect(result.errors.filter((e) => e.check === 'migrations')).toEqual([]);
  });

  it('official hello（core 级，无迁移）不触发迁移检查', () => {
    const result = validateModulePackage(helloPackageInput());
    expect(result.errors).toEqual([]);
  });
});

describe('契约真值锚定', () => {
  it('CONTRACT_VERSION 锚定 1.0（防止悄悄漂移）', () => {
    expect(CONTRACT_VERSION).toBe('1.0');
  });
});

describe('storage.declaration（#55 增量字段：安装时用户选定）', () => {
  function baseWithStorage(storage: Record<string, unknown>): Parameters<typeof validateModulePackage>[0] {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.storage = storage;
    return { ...base, manifestText: JSON.stringify(manifest) };
  }

  it('declaration 在 accepts 内 → 绿（shared 带 tables+迁移）', () => {
    // shared 选择：需带 tables + 迁移（自建表的既有硬护栏不回退；accepts 含 shared 时
    // 作者侧缺迁移仍拦——但 core 选择不触发任何建表路径，走 declaration-not-shared 分支）
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.storage = { accepts: ['core', 'shared'], preferred: 'core', declaration: 'shared' };
    manifest.tablesShared = ['todo_items'];
    const result = validateModulePackage({
      ...base,
      manifestText: JSON.stringify(manifest),
      migrations: { '0001_init.sql': 'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY);' },
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('declaration=core 且包内无迁移 → 绿（装 core 不建表；accepts 含 shared 的表清单归作者侧）', () => {
    // 旧路径拦「accepts 含 shared 但无迁移」；用户选 core 时不建表，不应拦安装
    const ok = validateModulePackage(baseWithStorage({ accepts: ['core', 'shared'], declaration: 'core' }));
    expect(ok.errors.filter((e) => e.check === 'tables')).toEqual([]);
    expect(ok.ok).toBe(true);
  });

  it('declaration 不在 accepts 内 → schema 层 error（选了声明之外的模式即拒绝安装，#55）', () => {
    const result = validateModulePackage(baseWithStorage({ accepts: ['core'], declaration: 'dedicated' }));
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.check)).toContain('storage');
    expect(result.errors.some((e) => e.message.includes('declaration') && e.message.includes('dedicated'))).toBe(true);
  });

  it('manifest.yaml 形态：storage.declaration 解析进候选（yaml 三字段齐备）', () => {
    const yaml = [
      'id: demo',
      'route: /m/demo',
      'entry: https://team.example.com/m/demo/',
      'runtimes:',
      '  - worker',
      'version: 1.0.0',
      'storage:',
      '  accepts:',
      '    - dedicated',
      '  preferred: dedicated',
      '  declaration: dedicated',
    ].join('\n');
    const parsed = ModuleManifestSchema.parse(manifestFromYamlText(yaml));
    expect(parsed.storage).toEqual({ accepts: ['dedicated'], preferred: 'dedicated', declaration: 'dedicated' });
  });
});

describe('manifest.license（SPDX 声明，issue #292）', () => {
  /** 带 license 字段的最小包。 */
  function withLicense(license: unknown): Parameters<typeof validateModulePackage>[0] {
    const base = minimalInput();
    const manifest = JSON.parse(base.manifestText) as Record<string, unknown>;
    manifest.license = license;
    return { ...base, manifestText: JSON.stringify(manifest) };
  }

  it('合法 SPDX（MIT）→ 通过（包内 LICENSE 仍在，两条规则各自满足）', () => {
    const result = validateModulePackage(withLicense('MIT'));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('合法复合 SPDX（MIT OR Apache-2.0）→ 通过', () => {
    const result = validateModulePackage(withLicense('MIT OR Apache-2.0'));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('非法 SPDX 形状（MIT OR）→ error(license)，且消息里可定位 license 字段', () => {
    const result = validateModulePackage(withLicense('MIT OR'));
    expect(result.ok).toBe(false);
    const licenseError = result.errors.find((e) => e.check === 'license');
    expect(licenseError).toBeDefined();
    expect(licenseError?.message).toContain('license');
  });

  it('空白串不是「未声明」→ error(license)（退回平台默认只发生在字段缺失时）', () => {
    const result = validateModulePackage(withLicense('   '));
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.check)).toContain('license');
  });

  it('非 string 类型（null / 数字）→ schema error，不静默忽略', () => {
    expect(validateModulePackage(withLicense(null)).ok).toBe(false);
    expect(validateModulePackage(withLicense(7)).ok).toBe(false);
  });

  it('向后兼容：manifest 无 license 字段仍通过 validate（老 manifest 不拦）', () => {
    // 未声明 license → 形状检查不适用；pack 侧回落平台默认（见 module-pack 测试）
    const result = validateModulePackage(minimalInput());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('manifest.license 合法但包内缺 LICENSE 文件 → 仍 error(license)（文件存在性与声明形状是两条独立规则）', () => {
    const result = validateModulePackage({ ...withLicense('MIT'), licenseText: undefined });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.check)).toContain('license');
    expect(result.errors.some((e) => e.message.includes('LICENSE'))).toBe(true);
  });

  it('manifest.yaml 形态：license 解析进候选并可过 schema', () => {
    const yaml = [
      'id: demo',
      'route: /m/demo',
      'entry: https://team.example.com/m/demo/',
      'runtimes:',
      '  - worker',
      'version: 1.0.0',
      'license: MIT',
    ].join('\n');
    const parsed = ModuleManifestSchema.parse(manifestFromYamlText(yaml));
    expect(parsed.license).toBe('MIT');
  });

  // —— YAML 入口的「声明存在性」（issue #292 退回）：只有完全省略才回落，非法声明必拒 ——

  /** 最小模块的 manifest.yaml；licenseLines 原样追加（省略 = 不声明）。 */
  function minimalYamlWithLicense(...licenseLines: string[]): string {
    return [
      'id: todo',
      'version: 1.0.0',
      'runtimes:',
      '  - worker',
      'route: /m/todo',
      'entry: https://team.example.com/m/todo/',
      ...licenseLines,
      '',
    ].join('\n');
  }

  /** YAML 形态的最小包输入（其余字段与 minimalInput 同值）。 */
  function yamlInput(...licenseLines: string[]): Parameters<typeof validateModulePackage>[0] {
    return { ...minimalInput(), manifestText: minimalYamlWithLicense(...licenseLines) };
  }

  it('YAML 真正省略 license → 通过（回落只发生在完全省略时）', () => {
    const result = validateModulePackage(yamlInput());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('YAML 合法 SPDX（MIT / MIT OR Apache-2.0）→ 通过', () => {
    expect(validateModulePackage(yamlInput('license: MIT')).ok).toBe(true);
    expect(validateModulePackage(yamlInput('license: MIT OR Apache-2.0')).ok).toBe(true);
  });

  const yamlIllegalDeclarations: Array<[string, string[]]> = [
    ['空值（只有 key）', ['license:']],
    ['空值 + 注释', ['license:   # explicit empty']],
    ['list 形态', ['license:', '  - MIT']],
    ['嵌套对象形态', ['license:', '  type: MIT']],
    ['非法 SPDX 形状', ['license: MIT OR']],
  ];

  it.each(yamlIllegalDeclarations)(
    'YAML 显式声明 %s → error(license)，不静默回落平台默认',
    (_label, lines) => {
      const result = validateModulePackage(yamlInput(...lines));
      expect(result.ok).toBe(false);
      expect(result.errors.map((e) => e.check)).toContain('license');
    },
  );

  it('JSON/YAML 两入口一致：同义声明同结果（非法必拒、合法/省略同过）', () => {
    const checks = (input: Parameters<typeof validateModulePackage>[0]) =>
      validateModulePackage(input).errors.map((e) => e.check);
    // 非法：YAML 空值 ↔ JSON ""；YAML list ↔ JSON []；YAML 嵌套对象 ↔ JSON {}；非法形状两边同拒
    expect(checks(yamlInput('license:'))).toContain('license');
    expect(checks(withLicense(''))).toContain('license');
    expect(checks(yamlInput('license:', '  - MIT'))).toContain('license');
    expect(checks(withLicense(['MIT']))).toContain('license');
    expect(checks(yamlInput('license:', '  type: MIT'))).toContain('license');
    expect(checks(withLicense({ type: 'MIT' }))).toContain('license');
    expect(checks(yamlInput('license: MIT OR'))).toContain('license');
    expect(checks(withLicense('MIT OR'))).toContain('license');
    // 合法与省略：两入口均通过
    expect(validateModulePackage(yamlInput('license: MIT')).ok).toBe(true);
    expect(validateModulePackage(withLicense('MIT')).ok).toBe(true);
    expect(validateModulePackage(yamlInput()).ok).toBe(true);
    expect(validateModulePackage(minimalInput()).ok).toBe(true);
  });
});
