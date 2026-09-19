// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 四级数据落点各跑一个模块（#248 验收①）：core / shared / dedicated / external
 * 四份 manifest 声明在同一次装配里各就其位——落点判定、迁移、绑定三处一致。
 *
 * 断言面（全部落在请求与账户态，不解析命令行）：
 * - shared：共享 modules 库建表，独立记账 unself_migrations_<id>；
 * - dedicated：专属 D1 `unself-<id>` 建库 + 独立记账 + 上传绑定 `<ID>_DB`；
 * - core：不建表、不建库、不记账；上传带 CORE_API service binding（代理唯一通道，收敛（a)）；
 * - external：装配器不接线（不建库、不记账、不建表）。
 * 平台基建（module_kv，modules 库）记账 unself_migrations_platform 与四者并存不互相覆盖。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runNineSteps } from '../src/steps';
import { RestClient } from '../src/rest/client';
import { makeCfRestFake } from './helpers/cf-rest-fake';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXED_JWKS = JSON.stringify({
  keys: [{
    kty: 'EC',
    crv: 'P-256',
    x: '2zYTVcy0bDXQ7qqeNDB38zsPVvwUkKZ6-m3xA1zwA2U',
    y: 'j8zUPxAyGRUAaHRNYwdU3IW7TSBI1kSrg7RmUhb8lZk',
    kid: 'RDB_5KqpPvLCvU7V6n8r6-xxpSJutKJCWNmyZWesNSg',
    use: 'sig',
    alg: 'ES256',
  }],
});

interface TierFixture {
  id: string;
  level: 'core' | 'shared' | 'dedicated' | 'external';
  tables?: string[];
  migration?: string;
}

/** 造一个最小模块包（manifest + worker 入口 + 可选迁移），落点按 fixture 声明。 */
async function writeFixture(rootDir: string, f: TierFixture): Promise<void> {
  const dir = join(rootDir, 'modules', f.id);
  await mkdir(join(dir, 'src'), { recursive: true });
  const lines = [
    `id: ${f.id}`,
    `route: /m/${f.id}`,
    `entry: http://localhost:8799/`,
    'runtimes:',
    '  - worker',
    'version: 0.1.0',
    `description: ${f.id} 落点夹具（#248）`,
    'permissions:',
    '  - storage',
    'storage:',
    '  accepts:',
    `    - ${f.level}`,
    `  preferred: ${f.level}`,
  ];
  if (f.tables?.length) {
    lines.push('tables:', ...f.tables.map((t) => `  - ${t}`));
  }
  await writeFile(join(dir, 'manifest.yaml'), lines.join('\n') + '\n');
  await writeFile(join(dir, 'src', 'index.ts'), 'export default { fetch: () => new Response("ok") };\n');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: `@unself/module-${f.id}`, version: '0.1.0', private: true, type: 'module', main: 'src/index.ts' }, null, 2),
  );
  if (f.migration) {
    await mkdir(join(dir, 'migrations', f.id), { recursive: true });
    await writeFile(join(dir, 'migrations', f.id, '0001_init.sql'), f.migration);
  }
}

describe('四级数据落点各跑一个模块（#248 ①）', () => {
  it('shared/dedicated 各建各的表与库并独立记账；core/external 不建表不记账', { timeout: 180_000 }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'unself-tiers-'));
    try {
      for (const rel of ['packages', 'services', 'apps', 'adapters']) {
        await symlink(join(REPO_ROOT, rel), join(rootDir, rel), 'dir');
      }
      await writeFixture(rootDir, {
        id: 'core-mod',
        level: 'core',
      });
      await writeFixture(rootDir, {
        id: 'shared-mod',
        level: 'shared',
        tables: ['shared_mod_items'],
        migration: 'CREATE TABLE IF NOT EXISTS shared_mod_items (id INTEGER PRIMARY KEY, note TEXT);\n',
      });
      await writeFixture(rootDir, {
        id: 'ded-mod',
        level: 'dedicated',
        tables: ['ded_mod_items'],
        migration: 'CREATE TABLE IF NOT EXISTS ded_mod_items (id INTEGER PRIMARY KEY);\n',
      });
      await writeFixture(rootDir, { id: 'ext-mod', level: 'external' });

      const fake = makeCfRestFake();
      const logs: string[] = [];
      await runNineSteps({
        rootDir,
        buildShell: async () => {},
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        yes: true,
      configOverride: {
          domain: '',
          modules: ['core-mod', 'shared-mod', 'ded-mod', 'ext-mod'].map((id) => ({ id, source: `file:./modules/${id}` })),
          storage: { provider: 'r2', bucket: 'unself-storage' },
        },
        fetchJwks: async () => FIXED_JWKS,
        http: { smoke: async () => [{ name: 'core-api', url: 'https://x/api/health', ok: true, status: 200 }] },
        reporter: { step: () => {}, log: (m: string) => logs.push(m) },
      });

      // 独立记账（#55 护栏①）：shared/dedicated 各一条，core/external 没有；
      // 平台基建（modules 库）另有一条，与模块记账互不覆盖。
      expect(fake.state.ledgerTables.has('unself_migrations_shared_mod')).toBe(true);
      expect(fake.state.ledgerTables.has('unself_migrations_ded_mod')).toBe(true);
      expect(fake.state.ledgerTables.has('unself_migrations_core_mod')).toBe(false);
      expect(fake.state.ledgerTables.has('unself_migrations_ext_mod')).toBe(false);
      expect(fake.state.ledgerTables.has('unself_migrations_platform')).toBe(true);
      expect([...fake.state.ledgerRows.get('unself_migrations_shared_mod') ?? []]).toEqual(['0001_init.sql']);
      expect([...fake.state.ledgerRows.get('unself_migrations_ded_mod') ?? []]).toEqual(['0001_init.sql']);
      expect([...fake.state.ledgerRows.get('unself_migrations_platform') ?? []]).toEqual(['0001_module_kv.sql']);

      // 库：只有 dedicated 建专属库（shared 用共享 modules 库；core/external 不建）
      expect(fake.state.d1.has('unself-ded-mod')).toBe(true);
      expect(fake.state.d1.has('unself-shared-mod')).toBe(false);
      expect(fake.state.d1.has('unself-core-mod')).toBe(false);
      expect(fake.state.d1.has('unself-ext-mod')).toBe(false);

      // 上传绑定：dedicated 绑专属库；core 绑 CORE_API（代理唯一通道）；shared 两者都不需要
      const bindingsOf = (worker: string): Array<{ type: string; name: string }> =>
        ((fake.state.uploads.find((u) => u.worker === worker)?.metadata as { bindings?: Array<{ type: string; name: string }> })
          ?.bindings ?? []);
      const dedNames = bindingsOf('unself-module-ded-mod').map((b) => `${b.type}:${b.name}`);
      expect(dedNames).toContain('d1:DED_MOD_DB');
      const coreNames = bindingsOf('unself-module-core-mod').map((b) => `${b.type}:${b.name}`);
      expect(coreNames).toContain('service:CORE_API');
      const sharedNames = bindingsOf('unself-module-shared-mod').map((b) => `${b.type}:${b.name}`);
      expect(sharedNames).not.toContain('service:CORE_API');
      expect(sharedNames).not.toContain('d1:SHARED_MOD_DB'); // shared 用共享库，不另建专属库
      const extNames = bindingsOf('unself-module-ext-mod').map((b) => `${b.type}:${b.name}`);
      expect(extNames).not.toContain('service:CORE_API');
      expect(extNames).not.toContain('d1:EXT_MOD_DB'); // external 连自备库，装配器不接线

      // 落点日志（部署者可复核：这一台实例上每个模块的数据在哪）
      expect(logs.some((l) => l.includes('模块 core-mod 落点 core'))).toBe(true);
      expect(logs.some((l) => l.includes('模块 shared-mod 落点 shared'))).toBe(true);
      expect(logs.some((l) => l.includes('模块 ded-mod 落点 dedicated'))).toBe(true);
      expect(logs.some((l) => l.includes('模块 ext-mod 落点 external'))).toBe(true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('shared 落点装到没申报的表 → 装配停住（护栏②：共享库不接收未经申报的表）', { timeout: 120_000 }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'unself-tiers-bad-'));
    try {
      for (const rel of ['packages', 'services', 'apps', 'adapters']) {
        await symlink(join(REPO_ROOT, rel), join(rootDir, rel), 'dir');
      }
      await writeFixture(rootDir, {
        id: 'bad-mod',
        level: 'shared',
        tables: ['bad_mod_items'],
        // 建的表名带前缀但**未申报**（护栏②），装配必须在跑迁移前停住
        migration: 'CREATE TABLE IF NOT EXISTS bad_mod_secret (id INTEGER PRIMARY KEY);\n',
      });
      const fake = makeCfRestFake();
      let thrown: unknown;
      try {
        await runNineSteps({
          rootDir,
          buildShell: async () => {},
          client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
          yes: true,
      configOverride: { domain: '', modules: [{ id: 'bad-mod', source: 'file:./modules/bad-mod' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
          fetchJwks: async () => FIXED_JWKS,
          http: { smoke: async () => [] },
          reporter: { step: () => {}, log: () => {} },
        });
      } catch (err) {
        thrown = err;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain('护栏');
      expect(message).toContain('bad_mod_secret');
      // 停住 = 表没建、也没记账（不会留下「装了一半」的库）
      expect(fake.state.ledgerTables.has('unself_migrations_bad_mod')).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
