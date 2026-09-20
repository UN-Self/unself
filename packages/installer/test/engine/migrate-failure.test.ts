// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 迁移失败的三要素定位（#248 验收⑥，docs/modules.md §6）：
 * 装到一半的库没人受益——失败必须**停住**并指出「模块 / 文件 / 第几条语句」，
 * 不自动重试、不自动回滚。这里跑真 `runNineSteps`（真步骤②代码路径）：
 * D1 import 在服务端报 error（注入的真错误明细）→ 装配中止 → 错误消息含三要素。
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runNineSteps } from '../../src/engine/steps';
import { RestClient } from '../../src/engine/rest/client';
import { makeCfRestFake } from './helpers/cf-rest-fake';

/** 最小 shell 产物（真 vite build 4.4s/次，测试不必跑）。 */
async function fakeBuildShell(rootDir: string): Promise<void> {
  const dist = join(rootDir, 'apps/shell/dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<html><body>TEST SHELL</body></html>');
}

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

/** 仓库根（真实 packages/ services/ apps/ 用软链进临时根：装配器要真打包 SDK 资产与 shell）。 */
const REPO_ROOT = new URL('../../../..', import.meta.url).pathname;

/** 造一个 shared 落点的坏迁移模块：第 2 条语句就是服务端会拒的那条。 */
async function makeBrokenModule(rootDir: string): Promise<void> {
  for (const rel of ['packages', 'services', 'apps', 'adapters']) {
    await symlink(join(REPO_ROOT, rel), join(rootDir, rel), 'dir');
  }
  const dir = join(rootDir, 'modules', 'broken');
  await mkdir(join(dir, 'migrations', 'broken'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.yaml'),
    [
      'id: broken',
      'route: /m/broken',
      'entry: http://localhost:8799/',
      'runtimes:',
      '  - worker',
      'version: 0.1.0',
      'description: 迁移失败定位夹具（#248）',
      'permissions:',
      '  - storage',
      'storage:',
      '  accepts:',
      '    - shared',
      '  preferred: shared',
      'tables:',
      '  - broken_seed',
      '  - broken_box',
      '',
    ].join('\n'),
  );
  // 最小 worker 入口（装配器在步骤②之前就会 esbuild 打包，夹具必须是可真打包的模块）
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'src', 'index.ts'),
    'export default { fetch: () => new Response("ok") };\n',
  );
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@unself/module-broken', version: '0.1.0', private: true, type: 'module', main: 'src/index.ts' }, null, 2),
  );
  // 3 条语句：第 1、3 条没问题；第 2 条（建 broken_box）是服务端报错的那条
  await writeFile(
    join(dir, 'migrations', 'broken', '0001_broken.sql'),
    [
      'CREATE TABLE IF NOT EXISTS broken_seed (id INTEGER PRIMARY KEY);',
      'CREATE TABLE IF NOT EXISTS broken_box (id INTEGER PRIMARY KEY);',
      'CREATE INDEX IF NOT EXISTS broken_box_id_idx ON broken_box (id);',
      '',
    ].join('\n'),
  );
}

describe('迁移失败：停住 + 模块/文件/第几条语句（#248 ⑥）', () => {
  it('服务端报错 → 装配中止，错误指出模块 broken / 文件 0001_broken.sql / 第 2 条语句', { timeout: 60_000 }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'unself-migfail-'));
    try {
      await makeBrokenModule(rootDir);
      const fake = makeCfRestFake({
        importFailure: { marker: 'broken_box', errors: ['near "broken_box": syntax error'] },
      });
      let thrown: unknown;
      try {
        await runNineSteps({
          rootDir,
          buildShell: fakeBuildShell,
          client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
          yes: true,
      configOverride: { domain: '', modules: [{ id: 'broken', source: 'file:./modules/broken' }], storage: { provider: 'r2', bucket: 'unself-storage' } },
          fetchJwks: async () => FIXED_JWKS,
          http: { smoke: async () => [{ name: 'core-api', url: 'https://x/api/health', ok: true, status: 200 }] },
        });
      } catch (err) {
        thrown = err;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain('模块 broken');
      expect(message).toContain('0001_broken.sql');
      expect(message).toContain('第 2 条语句');
      expect(message).toContain('near "broken_box": syntax error');
      // 停住纪律明示（不自动重试 / 不自动回滚，docs/modules.md §6）
      expect(message).toContain('不自动重试');
      // 失败后该文件**未记账**：重跑会整份重放（逐条幂等是硬要求的原因）
      expect(fake.state.importEtags.size).toBeGreaterThan(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
