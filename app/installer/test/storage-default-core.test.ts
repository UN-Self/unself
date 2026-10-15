// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #336 回归：manifest 省略 `storage` 的模块，走**向导④入口**（`runDeploy` + `storageChoices`）
 * 选默认 `core` 必须装通。
 *
 * 事故形状（#310 引入）：向导③½ 对每个模块都写 `storage.declaration`（含默认 core），
 * 引擎 `storagePlanOf` 在 manifest 未声明 storage 时兜底成 `accepts: []`，
 * 于是「有效 manifest」自相矛盾（accepts 空 + declaration ∉ accepts），前置校验拒绝安装。
 * 契约口径：`storage` 省略等价于只支持 `core`（docs/modules.md §3 字段表 / core/sdk contract-types）。
 *
 * 本文件刻意**不走** configOverride 直注，而是走向导真实链路：
 * 临时实例目录（真 `unself.config.jsonc`）+ `runDeploy`（向导④调用的那个函数）+ `storageChoices`。
 * 模块源用仓库里的真 `app/modules/hello`（真省略 storage），不是自造夹具——
 * 当初漏检正是因为比对样本里没有「省略 storage」这一支。
 *
 * 断言面全部落在行为与账户态：装通/拒绝、账户里建了什么、注册表快照记了什么。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInstanceDir } from '../src/lib/dir';
import { findRepoRoot } from './helpers/repo-root';

const REPO_ROOT = findRepoRoot();
/** 仓库里的真 hello 包：manifest 省略 `storage`（= 只支持 core）。 */
const HELLO_DIR = join(REPO_ROOT, 'app/modules/hello');

/** 合法公钥 JWKS（静态夹具，与 core GET /.well-known/jwks.json 同形）。 */
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

/** 向导④输入（与 web/state.ts 的 chooseStorage 产出同形）：模块 id → 四级之一。 */
type StorageChoices = Record<string, 'core' | 'shared' | 'dedicated' | 'external'>;

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'unself-336-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 合成平台产物夹具 + CF 账户态替身 + REST 客户端。 */
async function makeDeps() {
  const { writeWorkbenchFixture } = await import('./engine/helpers/workbench-fixture');
  const { makeCfRestFake } = await import('./engine/helpers/cf-rest-fake');
  const { RestClient } = await import('../src/engine/index');
  const workbenchDir = join(workDir, 'wb-fixture');
  await writeWorkbenchFixture(workbenchDir);
  const cf = makeCfRestFake();
  return { workbenchDir, cf, client: new RestClient({ token: 't', fetchImpl: cf.fetchImpl }) };
}

type CfState = Awaited<ReturnType<typeof makeDeps>>['cf']['state'];

/** 装配注入（跳过真网络；与 steps.test.ts 同形）。 */
function engineOverridesOf(deps: Awaited<ReturnType<typeof makeDeps>>) {
  return {
    workbenchDir: deps.workbenchDir,
    client: deps.client,
    http: {
      smoke: async (_b: string, mods: Array<{ id: string; baseUrl: string }>): Promise<
        Array<{ name: string; url: string; ok: boolean; status: number }>
      > => [
        { name: 'core-api', url: 'https://x/api/health', ok: true, status: 200 },
        ...mods.map((m) => ({ name: `module:${m.id}`, url: `${m.baseUrl}/api/health`, ok: true, status: 200 })),
      ],
      themeCheck: async () => [],
    },
    fetchJwks: async () => FIXED_JWKS,
  };
}

interface Outcome {
  ok: boolean;
  errorMessage: string | null;
  baseUrl?: string;
  state: CfState;
}

/**
 * 走一遍向导④的真实链路：建实例目录（真 config）→ `runDeploy`（含 storageChoices）。
 * `choices === undefined` = CLI 路径（不传 storageChoices）。
 */
async function deployViaWizard(
  dirName: string,
  modules: Array<{ id: string; source: string }>,
  choices?: StorageChoices,
): Promise<Outcome> {
  const { layout } = createInstanceDir(join(workDir, dirName), { modules, namespace: 'unself' });
  const deps = await makeDeps();
  const { runDeploy } = await import('../src/deploy');
  try {
    const result = await runDeploy({
      instancePath: layout.instanceDir,
      yes: true,
      ...(choices ? { storageChoices: choices } : {}),
      engineOverrides: engineOverridesOf(deps),
    });
    return { ok: true, errorMessage: null, baseUrl: result.baseUrl, state: deps.cf.state };
  } catch (err) {
    return { ok: false, errorMessage: err instanceof Error ? err.message : String(err), state: deps.cf.state };
  }
}

describe('#336 manifest 省略 storage 时，向导默认落点 core 必须装通', () => {
  it('向导③½ 默认 core（storageChoices.hello=core）→ 装通，终态 = core 落点，快照记 accepts:[core]', { timeout: 120_000 }, async () => {
    const r = await deployViaWizard('wizard', [{ id: 'hello', source: `file:${HELLO_DIR}` }], { hello: 'core' });
    if (!r.ok) console.log(`[#336] 向导默认 core 抛出：\n${r.errorMessage}`);
    expect(r.errorMessage).toBeNull();
    expect(r.baseUrl).toContain('workers.dev');

    // 终态 = core 落点：不建专属库、不建模块记账表、模块 worker 绑 CORE_API 代理
    expect(r.state.d1.has('unself-hello')).toBe(false);
    expect(r.state.ledgerTables.has('unself_migrations_hello')).toBe(false);
    const bindings = (r.state.uploads.find((u) => u.worker === 'unself-module-hello')?.metadata as {
      bindings?: Array<{ type: string; name: string }>;
    })?.bindings ?? [];
    expect(bindings.map((b) => `${b.type}:${b.name}`)).toContain('service:CORE_API');

    // 快照（注册表 = 「这台实例上模块数据在哪」的权威记录）必须是一份**合法**有效 manifest：
    // 省略 storage 按契约物化成 accepts:['core']，而不是空 accepts 或凭空追认用户选择。
    const snapshot = JSON.parse(r.state.registry.get('hello')!.manifest_json) as {
      storage?: { accepts?: string[]; declaration?: string };
    };
    expect(snapshot.storage).toEqual({ accepts: ['core'], declaration: 'core' });
  });

  it('CLI 路径（不传 storageChoices）→ 装通且快照不凭空补字段（不误伤）', { timeout: 120_000 }, async () => {
    const r = await deployViaWizard('cli', [{ id: 'hello', source: `file:${HELLO_DIR}` }]);
    if (!r.ok) console.log(`[#336] CLI 路径抛出：\n${r.errorMessage}`);
    expect(r.errorMessage).toBeNull();
    const snapshot = JSON.parse(r.state.registry.get('hello')!.manifest_json) as { storage?: unknown };
    // 省略 storage + 无用户选择 → 快照保持省略（引擎侧回落 core），不凭空补字段
    expect(snapshot.storage).toBeUndefined();
  });

  it('省略 storage 的模块选 shared → 前置拒绝，且账户零云写入（护栏不误放行）', { timeout: 120_000 }, async () => {
    const r = await deployViaWizard('shared', [{ id: 'hello', source: `file:${HELLO_DIR}` }], { hello: 'shared' });
    if (!r.ok) console.log(`[#336] 选 shared 抛出：\n${r.errorMessage}`);
    expect(r.errorMessage).toContain('accepts');
    // 拒绝发生在任何云资源写入之前：库/桶/KV/上传全空
    expect(r.state.d1.size).toBe(0);
    expect(r.state.buckets.size).toBe(0);
    expect(r.state.kv.size).toBe(0);
    expect(r.state.uploads).toHaveLength(0);
  });

  it('显式 accepts:[core] 的模块选 core → 照常装通（显式声明不受兜底影响）', { timeout: 120_000 }, async () => {
    // 与真 hello 同一份 manifest，只是补上显式声明：走 base.storage 已存在那一支
    const dir = join(workDir, 'mod-explicit');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.yaml'),
      [
        'id: explicit',
        'route: /m/explicit',
        'entry: http://localhost:8799/',
        'runtimes:',
        '  - worker',
        'version: 0.1.0',
        'description: 显式声明 accepts 的模块（#336 对照）',
        'permissions:',
        '  - storage',
        'storage:',
        '  accepts:',
        '    - core',
        '  preferred: core',
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'src', 'index.ts'), 'export default { fetch: () => new Response("ok") };\n');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@unself/module-explicit', version: '0.1.0', private: true, type: 'module', main: 'src/index.ts' }, null, 2),
    );

    const r = await deployViaWizard('explicit', [{ id: 'explicit', source: `file:${dir}` }], { explicit: 'core' });
    if (!r.ok) console.log(`[#336] 显式 accepts 抛出：\n${r.errorMessage}`);
    expect(r.errorMessage).toBeNull();
    expect(r.baseUrl).toContain('workers.dev');
  });
});
