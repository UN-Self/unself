// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateModulePackage } from '../src/validate';
import { CONTRACT_VERSION } from '../src/manifest';

/** 仓库根（packages/contracts → 上两级）。 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

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

/** chat 官方模块包输入：tables 申报 = schema-baseline.sql 的 18 张表（与迁移一致）。 */
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
      '0001_baseline.sql': readRepoFile('modules/chat/worker/schema-baseline.sql'),
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

  it('官方 chat 通过 validate（真实 schema-baseline.sql，18 张表申报一致）', () => {
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
    manifest.storage = { accepts: ['shared'] };
    manifest.tables = ['todo_items'];
    const undeclared = validateModulePackage({
      ...base,
      manifestText: JSON.stringify(manifest),
      migrations: {
        '0001_init.sql': 'CREATE TABLE IF NOT EXISTS todo_items (id INTEGER PRIMARY KEY);\nCREATE TABLE todo_extra (id INTEGER);',
      },
    });
    expect(undeclared.ok).toBe(false);
    expect(undeclared.errors.some((e) => e.check === 'tables' && e.message.includes('todo_extra'))).toBe(true);

    manifest.tables = ['todo_items', 'todo_ghost'];
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
    manifest.storage = { accepts: ['shared'] };
    manifest.tables = ['todo_items'];
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

describe('契约真值锚定', () => {
  it('CONTRACT_VERSION 锚定 1.0（防止悄悄漂移）', () => {
    expect(CONTRACT_VERSION).toBe('1.0');
  });
});
