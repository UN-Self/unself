// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 官方模块「一视同仁」端到端验收（issue #284 B1/B4/B5/B6，决策 #77）：
 * 同一份内容分别以 `npm:`（本地命中）与 `https:`（同内容 tarball）安装，**账户态逐项比对**；
 * 卸载走同一条路径（注册表快照驱动），官方与第三方口径一致、零残留。
 * 断言边界与 steps.test.ts 相同：cf-rest-fake 账户态 + runNineSteps 真实代码路径。
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packModuleDir } from '../src/module-pack';
import { runNineSteps } from '../src/steps';
import { removeModule } from '../src/uninstall';
import { sriFromBuffer } from '../src/sources';
import { makeCfRestFake } from './helpers/cf-rest-fake';
import { RestClient } from '../src/rest/client';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const HELLO_SOURCE = 'npm:@unself/hello@0.1.0';

const FIXED_JWKS = JSON.stringify({
  keys: [
    {
      kty: 'EC',
      crv: 'P-256',
      x: '2zYTVcy0bDXQ7qqeNDB38zsPVvwUkKZ6-m3xA1zwA2U',
      y: 'j8zUPxAyGRUAaHRNYwdU3IW7TSBI1kSrg7RmUhb8lZk',
      kid: 'RDB_5KqpPvLCvU7V6n8r6-xxpSJutKJCWNmyZWesNSg',
      use: 'sig',
      alg: 'ES256',
    },
  ],
});

const SMOKE_OK = {
  smoke: async (b: string, mods: Array<{ id: string; baseUrl: string }>) =>
    [{ name: 'core-api', url: `${b}/api/health`, ok: true, status: 200 }].concat(
      mods.map((m) => ({ name: `module:${m.id}`, url: `${m.baseUrl}/api/health`, ok: true, status: 200 })),
    ) as Array<{ name: string; url: string; ok: boolean; status: number }>,
};

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 造实例目录：symlink 仓库 packages/services/adapters（core 迁移 SQL / core worker 入口依赖）；apps 不 symlink，壳产物由注入的 buildShell 写进本目录。 */
async function makeRootDir(tag: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), `unself-284-e2e-${tag}-`));
  tempDirs.push(rootDir);
  for (const rel of ['packages', 'services', 'adapters']) {
    await symlink(join(REPO_ROOT, rel), join(rootDir, rel), 'dir');
  }
  return rootDir;
}

/** 注入的壳构建：写最小壳产物到 <rootDir>/apps/shell/dist（不跑真 vite build）。 */
async function fakeBuildShell(rootDir: string): Promise<void> {
  const dist = join(rootDir, 'apps/shell/dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<html><body>TEST SHELL</body></html>');
}

/** 注入的 download：把「同内容 tarball」当成远端产物取回（不联网）。 */
function localTarballFetcher(tarballPath: string) {
  return {
    download: async (i: { url: string; dest: string }) => {
      const bytes = await readFile(tarballPath);
      await mkdir(join(i.dest, '..'), { recursive: true });
      await writeFile(i.dest, bytes);
      return { sri: sriFromBuffer(bytes), size: bytes.byteLength };
    },
  };
}

type Fake = ReturnType<typeof makeCfRestFake>;

async function deploy(input: {
  rootDir: string;
  source: string;
  fake: Fake;
  yes?: boolean;
  preLock?: string;
  fetchers?: Record<string, unknown>;
}): Promise<void> {
  await runNineSteps({
    rootDir: input.rootDir,
    client: new RestClient({ token: 't', fetchImpl: input.fake.fetchImpl }),
    buildShell: fakeBuildShell,
    configOverride: {
      domain: '',
      modules: [{ id: 'hello', source: input.source }],
      storage: { provider: 'r2', bucket: 'unself-storage' },
    },
    ...(input.yes !== false ? { yes: true } : {}),
    ...(input.preLock !== undefined ? { preLock: input.preLock } : {}),
    ...(input.fetchers ? { fetchers: input.fetchers as never } : {}),
    fetchJwks: async () => FIXED_JWKS,
    http: SMOKE_OK,
    reporter: { step: () => {}, log: () => {} },
  });
}

describe('#284 B1/B4：npm 本地命中 与 同内容 tarball 的安装结果逐项一致', () => {
  it('注册表快照 / 路由 / 建表 / 权限投影一致；同 config 重跑零新建零重传', { timeout: 180_000 }, async () => {
    // 同内容 tarball：由 hello 包目录打包（与发布形态同一打包器）
    const packOut = await mkdtemp(join(tmpdir(), 'unself-284-pack-'));
    tempDirs.push(packOut);
    const packed = await packModuleDir({ dir: join(REPO_ROOT, 'modules', 'hello'), outDir: packOut, npmName: '@unself/hello' });

    const rootA = await makeRootDir('npm');
    const fakeA = makeCfRestFake();
    await deploy({ rootDir: rootA, source: HELLO_SOURCE, fake: fakeA });

    const rootB = await makeRootDir('tgz');
    const fakeB = makeCfRestFake();
    await deploy({
      rootDir: rootB,
      source: 'https://example.invalid/hello-0.1.0.tgz',
      fake: fakeB,
      fetchers: localTarballFetcher(packed.tarballPath),
    });

    // ---- 注册表记录（含 manifest 投影与权限投影）逐项一致 ----
    const rowA = fakeA.state.registry.get('hello');
    const rowB = fakeB.state.registry.get('hello');
    expect(rowA).toBeDefined();
    expect(rowB).toEqual(rowA);
    const manifestA = JSON.parse(rowA!.manifest_json) as Record<string, unknown>;
    expect(manifestA.permissions).toEqual(['storage']);
    expect(manifestA.id).toBe('hello');
    expect(manifestA.version).toBe('0.1.0');
    expect(manifestA.entry).toBe('https://unself-module-hello.test-subdomain.workers.dev/');

    // ---- 路由/子域：workers.dev 形态 = 模块自有子域（无 zone 路由） ----
    expect([...fakeB.state.workersDevEnabled].sort()).toEqual([...fakeA.state.workersDevEnabled].sort());

    // ---- 建表：同一套记账（hello 落 core → 只 core/platform 记账表） ----
    expect([...fakeB.state.ledgerTables].sort()).toEqual([...fakeA.state.ledgerTables].sort());
    expect(fakeA.state.ledgerTables.has('unself_migrations_hello')).toBe(false); // core 落点无模块记账

    // ---- 上传的 Worker 名一致（同一个模块 Worker） ----
    const workersA = fakeA.state.uploads.map((u) => u.worker).sort();
    const workersB = fakeB.state.uploads.map((u) => u.worker).sort();
    expect(workersB).toEqual(workersA);
    expect(workersA).toContain('unself-module-hello');

    // ---- B6：同 config 重跑（用上一次写下的 lock）→ 零新建、零重传（未变资产不重传） ----
    // 稳定态重跑：第 1 跑会把 JWT secret 写下去（核心 Worker 因此多传一次），故从第 2 跑开始比。
    const lockText = await readFile(join(rootA, 'unself.lock'), 'utf8');
    const manifestsBeforeRun2 = fakeA.state.assetManifests.length;
    await deploy({ rootDir: rootA, source: HELLO_SOURCE, fake: fakeA, preLock: lockText });
    const manifestsBeforeRun3 = fakeA.state.assetManifests.length;

    const callsBeforeRun3 = fakeA.calls.length;
    const secretPutsBeforeRun3 = fakeA.state.secretPuts.length;
    await deploy({ rootDir: rootA, source: HELLO_SOURCE, fake: fakeA, preLock: lockText });

    // 不重复建资源（D1 create 零新增）
    expect(
      fakeA.calls
        .slice(callsBeforeRun3)
        .filter((c) => c.method === 'POST' && c.url.endsWith('/d1/database')),
    ).toHaveLength(0);
    // 不重写 secret
    expect(fakeA.state.secretPuts.length).toBe(secretPutsBeforeRun3);
    // 未变资产 hash 清单逐项相同（真机侧 CF 按 hash 判定「缺失才传」→ hash 不变即不重传）
    const run2Manifests = fakeA.state.assetManifests.slice(manifestsBeforeRun2, manifestsBeforeRun3);
    const run3Manifests = fakeA.state.assetManifests.slice(manifestsBeforeRun3);
    expect(run3Manifests.length).toBeGreaterThan(0);
    expect(run3Manifests).toEqual(run2Manifests);
  });
});

describe('#284 B5：卸载一视同仁（官方/第三方同口径，零残留）', () => {
  /** shared 落点 fixture 包（表清单 + 迁移），落点由 manifest 声明。 */
  async function writeSharedFixture(dir: string, id: string, version = '0.1.0'): Promise<void> {
    await mkdir(join(dir, 'migrations', id), { recursive: true });
    const table = `${id.replaceAll('-', '_')}_items`;
    await writeFile(
      join(dir, 'manifest.json'),
      `${JSON.stringify(
        {
          id,
          version,
          runtimes: ['worker'],
          route: `/m/${id}`,
          entry: 'http://localhost:9999/',
          permissions: ['storage'],
          storage: { accepts: ['shared'], preferred: 'shared' },
          tables: [table],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(dir, 'worker.js'), 'export default { fetch: () => new Response("ok") };\n');
    await writeFile(join(dir, 'LICENSE'), 'AGPL-3.0-only\n');
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: `@acme/${id}`, version, files: ['manifest.json', 'worker.js', 'LICENSE', 'migrations'] }, null, 2)}\n`,
    );
    await writeFile(
      join(dir, 'migrations', id, '0001_init.sql'),
      `CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY);\n`,
    );
  }

  it('npm 本地命中的模块与同内容 file: 目录：卸载结果逐字相同，sqlite_master 零残留', { timeout: 180_000 }, async () => {
    const results: Array<{ rootDir: string; fake: Fake }> = [];
    for (const [tag, source] of [
      ['npm', 'npm:@acme/todo@0.1.0'],
      ['file', 'file:./fixtures/todo'],
    ] as const) {
      const rootDir = await makeRootDir(`rm-${tag}`);
      if (tag === 'npm') {
        // 发布形态落 node_modules（npm 本地命中）
        await writeSharedFixture(join(rootDir, 'node_modules', '@acme', 'todo'), 'todo');
      } else {
        // 本地目录形态（file:）
        await writeSharedFixture(join(rootDir, 'fixtures', 'todo'), 'todo');
      }
      const fake = makeCfRestFake();
      await runNineSteps({
        rootDir,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        buildShell: fakeBuildShell,
      configOverride: {
          domain: '',
          modules: [{ id: 'todo', source }],
          storage: { provider: 'r2', bucket: 'unself-storage' },
        },
        yes: true,
        fetchJwks: async () => FIXED_JWKS,
        http: SMOKE_OK,
        reporter: { step: () => {}, log: () => {} },
      });
      // 装好了：注册表有行、清单表已建（shared → modules 库）
      expect(fake.state.registry.get('todo')?.enabled).toBe(1);

      const removed = await removeModule({
        rootDir,
        moduleId: 'todo',
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
      configOverride: {
          domain: '',
          modules: [{ id: 'todo', source }],
          storage: { provider: 'r2', bucket: 'unself-storage' },
        },
        log: () => {},
      });
      results.push({ rootDir, fake });
      // 与来源无关的卸载结果（同口径）
      expect(removed.level).toBe('shared');
      expect(removed.tablesDropped).toEqual(['todo_items']);
      expect(removed.ledgerTable).toBe('unself_migrations_todo');
      expect(removed.removedFromRegistry).toBe(true);
      expect(removed.workerDeleted).toBe(true);
      // 零残留：清单表 + 记账表全删、注册表无行、Worker 不存在
      expect(fake.state.droppedTables.sort()).toEqual(['todo_items', 'unself_migrations_todo']);
      expect([...fake.state.ledgerTables.keys()]).not.toContain('unself_migrations_todo');
      expect(fake.state.registry.get('todo')).toBeUndefined();
      expect(fake.state.existingWorkers.has('unself-module-todo')).toBe(false);
      // lock 台账也清了该模块
      const lock = JSON.parse(await readFile(join(rootDir, 'unself.lock'), 'utf8')) as { modules: Record<string, unknown> };
      expect(lock.modules.todo).toBeUndefined();
    }
    // 两次卸载的结果态一致（官方/第三方一视同仁）
    expect(results[1]!.fake.state.droppedTables.sort()).toEqual(results[0]!.fake.state.droppedTables.sort());
  });
});
