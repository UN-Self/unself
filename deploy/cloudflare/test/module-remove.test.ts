// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 引擎卸载（#270）行为测试：装一个模块 → 卸载 → 无残留表 / 路由 / Worker / 注册表。
 *
 * 断言全部落在「发了哪些请求、账户态如何变」，与九步测试同一边界（cf-rest-fake）。
 * 硬规则：
 * - 只 DROP `manifest.tables` 清单里的表 + 本模块记账表（不许误删别的模块/平台表）；
 * - 注册表删行 = token 门禁失效（core-api 侧语义见 T6）；
 * - 幂等：重复卸载不报错、不重复删。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { makeCfRestFake } from './helpers/cf-rest-fake';
import { createCoreControlPlane } from '../src/control-plane';
import { RestClient, d1List } from '../src/rest';
import { emptyLock, serializeLock } from '../src/lock';
import { removeModule } from '../src/uninstall';

const ACCOUNT = 'f7351bdd-acc0-0000-0000-000000000001';

/** 造一个「已装模块」的账户态：registry 快照（+ 调用方预置 Worker/ledger/route）。 */
async function seed(input: {
  id: string;
  level: 'core' | 'shared' | 'dedicated';
  tables: string[];
  fake: ReturnType<typeof makeCfRestFake>;
}): Promise<{ client: RestClient; coreUuid: string }> {
  const client = new RestClient({ token: 't', fetchImpl: input.fake.fetchImpl });
  const coreUuid = await dbUuid(client, 'unself-core');
  const manifest = {
    id: input.id,
    version: '1.0.0',
    runtimes: ['worker'],
    route: `/m/${input.id}`,
    entry: `https://team.example.com/m/${input.id}/`,
    storage: { accepts: [input.level], declaration: input.level },
    tables: input.tables,
  };
  await createCoreControlPlane(client, ACCOUNT, coreUuid).upsertModule({ id: input.id, enabled: true, manifest });
  return { client, coreUuid };
}

/** fake 里某个库的 uuid（按库名确定性派生）。 */
async function dbUuid(client: RestClient, name: string): Promise<string> {
  const dbs = await d1List(client, ACCOUNT);
  const found = dbs.find((d) => d.name === name);
  if (!found) throw new Error(`fake 无 D1 ${name}`);
  return found.uuid;
}

async function makeInstance(tag: string, lockText?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `unself-270-${tag}-`));
  await writeFile(
    join(dir, 'unself.config.jsonc'),
    '{"domain":"team.example.com","modules":[],"storage":{"provider":"r2","bucket":"unself-storage"}}\n',
  );
  if (lockText !== undefined) await writeFile(join(dir, 'unself.lock'), lockText);
  return dir;
}

describe('#270 引擎卸载：按 tables 清单清理', () => {
  it('shared 模块：只 DROP 清单表 + 记账表；别的模块/平台表不动', async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingWorkers: ['unself-module-todo'],
      existingLedger: {
        unself_migrations_todo: ['0001_init.sql'],
        unself_migrations_other: ['0001_init.sql'],
      },
      zones: { 'team.example.com': 'zone-1' },
      routes: [['team.example.com/m/todo/*', 'unself-module-todo']],
    });
    const { client, coreUuid } = await seed({ id: 'todo', level: 'shared', tables: ['todo_items', 'todo_lists'], fake });
    const modulesUuid = await dbUuid(client, 'unself-modules');
    const rootDir = await makeInstance('shared');

    const result = await removeModule({ rootDir, moduleId: 'todo', client });

    expect(result.level).toBe('shared');
    expect(result.tablesDropped).toEqual(['todo_items', 'todo_lists']);
    expect(result.ledgerTable).toBe('unself_migrations_todo');
    expect(result.removedFromRegistry).toBe(true);
    expect(result.workerDeleted).toBe(true);
    expect(result.routeRemoved).toBe(true);

    // 只删清单表 + 本模块记账表；别的模块记账表 / 平台表分毫未动
    expect(fake.state.droppedTables.sort()).toEqual(['todo_items', 'todo_lists', 'unself_migrations_todo']);
    expect(fake.state.droppedTables).not.toContain('unself_migrations_other');
    expect(fake.state.droppedTables).not.toContain('module_kv');
    // 全部落在 modules 库（shared 落点），core 库一个表都没删
    expect(fake.state.droppedByDb.get(modulesUuid)?.sort()).toEqual([
      'todo_items',
      'todo_lists',
      'unself_migrations_todo',
    ]);
    expect(fake.state.droppedByDb.get(coreUuid)).toBeUndefined();

    // 路由与 Worker 消失、注册表无该模块
    expect(fake.state.routes.has('team.example.com/m/todo/*')).toBe(false);
    expect(fake.state.deletedWorkers.has('unself-module-todo')).toBe(true);
    expect(fake.state.existingWorkers.has('unself-module-todo')).toBe(false);
    const registry = await createCoreControlPlane(client, ACCOUNT, coreUuid).readRegistry();
    expect(registry.find((m) => m.id === 'todo')).toBeUndefined();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('dedicated 模块：DROP 落专属库（表名无需模块前缀，chat 形态）', async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules', 'unself-notes'],
      existingWorkers: ['unself-module-notes'],
      existingLedger: { unself_migrations_notes: ['0001_init.sql'] },
    });
    const { client } = await seed({ id: 'notes', level: 'dedicated', tables: ['notes_a', 'notes_b'], fake });
    const notesUuid = await dbUuid(client, 'unself-notes');
    const rootDir = await makeInstance('dedicated');
    const result = await removeModule({ rootDir, moduleId: 'notes', client });

    expect(result.level).toBe('dedicated');
    expect(result.tablesDropped).toEqual(['notes_a', 'notes_b']);
    expect(fake.state.droppedByDb.get(notesUuid)?.sort()).toEqual(['notes_a', 'notes_b', 'unself_migrations_notes']);
    expect(fake.state.droppedByDb.size).toBe(1);
    // 无 domain → 无 zone 路由动作
    expect(fake.find('/workers/routes')).toBeUndefined();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('core 模块：无表可删（平台不碰 core 的表）', async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingWorkers: ['unself-module-hello'],
      existingLedger: { unself_migrations_core: ['0001_init.sql'] },
    });
    const { client, coreUuid } = await seed({ id: 'hello', level: 'core', tables: [], fake });
    const rootDir = await makeInstance('core');
    const result = await removeModule({ rootDir, moduleId: 'hello', client });

    expect(result.level).toBe('core');
    expect(result.tablesDropped).toEqual([]);
    expect(fake.state.droppedTables).toEqual([]);
    expect(result.removedFromRegistry).toBe(true);
    expect((await createCoreControlPlane(client, ACCOUNT, coreUuid).readRegistry()).find((m) => m.id === 'hello')).toBeUndefined();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('幂等：重复卸载不报错、不重复删、不误删', async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingWorkers: ['unself-module-todo'],
      existingLedger: { unself_migrations_todo: ['0001_init.sql'] },
      zones: { 'team.example.com': 'zone-1' },
      routes: [['team.example.com/m/todo/*', 'unself-module-todo']],
    });
    const { client } = await seed({ id: 'todo', level: 'shared', tables: ['todo_items'], fake });
    const rootDir = await makeInstance('idem');
    await removeModule({ rootDir, moduleId: 'todo', client });
    const first = [...fake.state.droppedTables];

    const second = await removeModule({ rootDir, moduleId: 'todo', client });

    expect(second.tablesDropped).toEqual([]);
    expect(second.workerDeleted).toBe(false);
    expect(second.removedFromRegistry).toBe(false);
    expect(fake.state.droppedTables).toEqual(first);
    expect(fake.state.droppedTables).not.toContain('module_kv');
    await rm(rootDir, { recursive: true, force: true });
  });

  it('清记账：卸完后重装（applyMigrations）会重建表，而不是被记账跳过', async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingWorkers: ['unself-module-todo'],
      existingLedger: { unself_migrations_todo: ['0001_init.sql'] },
    });
    const { client } = await seed({ id: 'todo', level: 'shared', tables: ['todo_items'], fake });
    const modulesUuid = await dbUuid(client, 'unself-modules');
    const rootDir = await makeInstance('reinstall');
    await removeModule({ rootDir, moduleId: 'todo', client });

    // 重装：同一份迁移再应用（记账表已被清 → 必须重放，而不是记成已应用）
    const cp = createCoreControlPlane(client, ACCOUNT, modulesUuid);
    expect(await cp.appliedMigrations('todo')).toEqual([]);
    const report = await cp.applyMigrations('todo', [
      { name: '0001_init.sql', sql: 'CREATE TABLE IF NOT EXISTS todo_items (id TEXT);' },
    ]);
    expect(report.applied).toEqual(['0001_init.sql']);
    expect(report.skipped).toEqual([]);
    await rm(rootDir, { recursive: true, force: true });
  });

  it('清单指向保留表 → 拒绝卸载（assertDroppable，宁停不住）', async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingWorkers: ['unself-module-evil'],
      zones: { 'team.example.com': 'zone-1' },
      routes: [['team.example.com/m/evil/*', 'unself-module-evil']],
    });
    const { client, coreUuid } = await seed({ id: 'evil', level: 'shared', tables: ['module_kv'], fake });
    const rootDir = await makeInstance('reserved');
    await expect(removeModule({ rootDir, moduleId: 'evil', client })).rejects.toThrow(/保留表/);
    // 拒绝发生在删表之前：注册表行仍在、无任何 DROP
    expect((await createCoreControlPlane(client, ACCOUNT, coreUuid).readRegistry()).find((m) => m.id === 'evil')).toBeDefined();
    expect(fake.state.droppedTables).toEqual([]);
    await rm(rootDir, { recursive: true, force: true });
  });

  it('shared 落点表名不带模块前缀 → 拒绝卸载（护栏③）', async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingWorkers: ['unself-module-todo'],
    });
    const { client } = await seed({ id: 'todo', level: 'shared', tables: ['other_items'], fake });
    const rootDir = await makeInstance('prefix');
    await expect(removeModule({ rootDir, moduleId: 'todo', client })).rejects.toThrow(/不带模块前缀/);
    await rm(rootDir, { recursive: true, force: true });
  });

  it('更新 unself.lock：去模块条目与 worker 台账，保留其它资源', async () => {
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingWorkers: ['unself-module-todo', 'unself-core-api'],
    });
    const { client, coreUuid } = await seed({ id: 'todo', level: 'shared', tables: ['todo_items'], fake });
    const lock = emptyLock();
    lock.modules.todo = {
      source: 'builtin:todo',
      version: '1.0.0',
      manifestHash: 'a'.repeat(64),
      contractVersion: '1.0',
    };
    lock.modules.other = {
      source: 'builtin:other',
      version: '1.0.0',
      manifestHash: 'b'.repeat(64),
      contractVersion: '1.0',
    };
    lock.resources = {
      d1: [{ name: 'unself-core', id: coreUuid }],
      kv: [],
      r2: [],
      workers: [{ name: 'unself-module-todo' }, { name: 'unself-core-api' }],
    };
    const rootDir = await makeInstance('lock', serializeLock(lock));

    const result = await removeModule({ rootDir, moduleId: 'todo', client });
    expect(result.lockUpdated).toBe(true);

    const next = JSON.parse(await readFile(join(rootDir, 'unself.lock'), 'utf8')) as {
      modules: Record<string, unknown>;
      resources: { workers: Array<{ name: string }>; d1: Array<{ name: string }> };
    };
    expect(next.modules.todo).toBeUndefined();
    expect(next.modules.other).toBeDefined();
    expect(next.resources.workers.map((w) => w.name)).toEqual(['unself-core-api']);
    expect(next.resources.d1.map((d) => d.name)).toEqual(['unself-core']);
    await rm(rootDir, { recursive: true, force: true });
  });

  it('资源命名空间：注册表与删表都落到 <ns>-core / <ns>-modules', async () => {
    const fake = makeCfRestFake({
      existingD1: ['probe270-core', 'probe270-modules'],
      existingWorkers: ['probe270-module-todo'],
      existingLedger: { unself_migrations_todo: ['0001_init.sql'] },
    });
    const client = new RestClient({ token: 't', fetchImpl: fake.fetchImpl });
    // 命名空间实例的注册表：core uuid 按 probe270-core 派生
    const nsCoreUuid = (await d1List(client, ACCOUNT)).find((d) => d.name === 'probe270-core')!.uuid;
    const nsModulesUuid = (await d1List(client, ACCOUNT)).find((d) => d.name === 'probe270-modules')!.uuid;
    await createCoreControlPlane(client, ACCOUNT, nsCoreUuid).upsertModule({
      id: 'todo',
      enabled: true,
      manifest: {
        id: 'todo',
        version: '1.0.0',
        runtimes: ['worker'],
        route: '/m/todo',
        entry: 'https://team.example.com/m/todo/',
        storage: { accepts: ['shared'], declaration: 'shared' },
        tables: ['todo_items'],
      },
    });
    const rootDir = await makeInstance('ns');
    const result = await removeModule({
      rootDir,
      moduleId: 'todo',
      client,
      configOverride: {
        domain: '',
        namespace: 'probe270',
        modules: [],
        storage: { provider: 'r2', bucket: 'probe270-storage' },
      },
    });
    expect(result.tablesDropped).toEqual(['todo_items']);
    expect(fake.state.droppedByDb.get(nsModulesUuid)?.sort()).toEqual(['todo_items', 'unself_migrations_todo']);
    expect(fake.state.droppedByDb.get(nsCoreUuid)).toBeUndefined();
    await rm(rootDir, { recursive: true, force: true });
  });
});
