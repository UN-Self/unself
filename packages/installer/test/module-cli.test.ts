// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #269 `unself module pack` / `unself module add` CLI 行为测试。
 *
 * 验收对照：
 * - `module pack <目录>` 产出 .tgz 并打印 integrity（与 builtin 同一条路：引擎 modulePackageFiles）；
 * - `module add <来源>` 解析（含权限门禁）→ 写 config modules 段 + unself.lock（重跑不再漂移）；
 * - `deploy --yes` 把「漂移已确认」传给九步引擎。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, run, type RunOptions } from '../src/cli';
import { instanceLayout } from '../src/lib/dir';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const HELLO_DIR = join(REPO_ROOT, 'modules/hello');

let home: string;
let cwd: string;
let out: string[];
let errs: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'unself-269-cli-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'unself-269-cli-cwd-'));
  out = [];
  errs = [];
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function opts(argv: string[], extra?: Partial<RunOptions>): RunOptions & { exitCode: () => number } {
  let code = -1;
  return {
    argv,
    env: {},
    home,
    cwd,
    log: (l) => out.push(l),
    err: (l) => errs.push(l),
    exit: (c) => {
      code = c;
    },
    exitCode: () => code,
    ...extra,
  };
}

describe('#269 parseArgs：module / --yes', () => {
  it('--yes 剥出；module 是已知命令', () => {
    expect(parseArgs(['deploy', '--yes'])).toMatchObject({ cmd: 'deploy', yes: true });
    expect(parseArgs(['module', 'pack', 'x'])).toMatchObject({ cmd: 'module', args: ['pack', 'x'], yes: false });
  });
});

describe('#269 unself module pack', () => {
  it('把 modules/hello 打成 .tgz，打印 integrity 与包文件清单', async () => {
    const o = opts(['module', 'pack', HELLO_DIR, '--out', cwd]);
    await run(o);
    expect(o.exitCode()).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('已打包模块：hello v0.1.0');
    expect(text).toContain('integrity：sha512-');
    expect(text).toContain('manifest.json');
    expect(text).toContain('worker.js');
    expect(existsSync(join(cwd, 'hello-0.1.0.tgz'))).toBe(true);
  }, 60_000);

  it('目录缺 manifest → 退出码 1 + 人话错误', async () => {
    const o = opts(['module', 'pack', cwd]);
    await run(o);
    expect(o.exitCode()).toBe(1);
    expect(errs.join('\n')).toContain('错误');
  });
});

describe('#269 unself module add', () => {
  it('file: 来源：写 config modules 段 + unself.lock；重复添加拒绝', async () => {
    const init = opts(['init', 'demo']);
    await run(init);
    expect(init.exitCode()).toBe(0);
    const layout = instanceLayout(join(cwd, 'demo'));
    // 干净实例语义：默认 builtin hello 先移除（否则与包的 manifest.id 撞名，正是 --as 的适用场景）
    writeFileSync(layout.configPath, readFileSync(layout.configPath, 'utf8').replace('"modules": ["hello"]', '"modules": []'));

    const add = opts(['module', 'add', `file:${HELLO_DIR}`]);
    await run(add);
    if (add.exitCode() !== 0) throw new Error(`module add 失败：${errs.join('\n')}`);
    expect(add.exitCode()).toBe(0);
    expect(out.join('\n')).toContain('已添加模块：hello');

    const config = readFileSync(layout.configPath, 'utf8');
    const lock = JSON.parse(readFileSync(layout.lockPath, 'utf8')) as {
      modules: Record<string, { source: string; version: string; manifestHash: string; contractVersion: string }>;
    };
    expect(config).toContain(`"source":"file:${HELLO_DIR}"`);
    expect(lock.modules.hello).toMatchObject({ source: `file:${HELLO_DIR}`, version: '0.1.0' });
    expect(lock.modules.hello!.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.modules.hello!.contractVersion).toMatch(/^\d+\.\d+$/);

    // 重复添加：不静默覆盖
    const again = opts(['module', 'add', `file:${HELLO_DIR}`]);
    await run(again);
    expect(again.exitCode()).toBe(1);
    expect(errs.join('\n')).toContain('已在 unself.config.jsonc');

    // 紧接的 `unself deploy` 不会因「来源漂移未确认」报错：lock 已命中 → 动作 reuse（#245 安全闸门不变）
    const engine = await import('@unself/deploy-cloudflare');
    const cfg = engine.parseUnselfConfigText(config);
    const plan = engine.buildLockPlan({
      entries: engine.normalizeModuleEntries(cfg.modules),
      lock: engine.parseLockText(readFileSync(layout.lockPath, 'utf8')),
    });
    expect(plan.items.find((i) => i.id === 'hello')?.action).toBe('reuse');
    expect(plan.removed).toHaveLength(0);
  }, 60_000);

  it('--as 覆盖实例内 id（撞名时不静默覆盖，改名是显式动作）', async () => {
    await run(opts(['init', 'demo']));
    const layout = instanceLayout(join(cwd, 'demo'));
    const add = opts(['module', 'add', `file:${HELLO_DIR}`, '--as', 'hello-lib']);
    await run(add);
    expect(add.exitCode()).toBe(0);
    expect(out.join('\n')).toContain('实例内命名覆盖：hello → hello-lib');
    const lock = JSON.parse(readFileSync(layout.lockPath, 'utf8')) as { modules: Record<string, { source: string }> };
    expect(lock.modules['hello-lib']).toMatchObject({ source: `file:${HELLO_DIR}` });
    expect(lock.modules.hello).toBeUndefined();
  }, 60_000);

  it('未知能力包 → 退出码 1 且点名能力（权限门禁用户面）', async () => {
    const init = opts(['init', 'demo']);
    await run(init);
    const modDir = join(cwd, 'evil');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(modDir, { recursive: true });
    writeFileSync(
      join(modDir, 'manifest.json'),
      `${JSON.stringify(
        {
          id: 'evil',
          version: '1.0.0',
          runtimes: ['worker'],
          route: '/m/evil',
          entry: 'https://evil.example.com/',
          permissions: ['storage', 'telepathy'],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(modDir, 'worker.js'), 'export default { fetch: () => new Response("x") };\n');
    const r = opts(['module', 'add', `file:${modDir}`]);
    await run(r);
    expect(r.exitCode()).toBe(1);
    expect(errs.join('\n')).toContain('telepathy');
  }, 60_000);
});

describe('#269 unself deploy --yes', () => {
  it('--yes 传进九步引擎调用', async () => {
    const init = opts(['init', 'demo']);
    await run(init);
    const seen: Array<Record<string, unknown>> = [];
    const o = opts(['deploy', '--yes'], {
      deployNineSteps: async (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        return { baseUrl: 'https://demo-core-api.workers.dev', setupToken: null };
      },
    });
    await run(o);
    expect(o.exitCode()).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.yes).toBe(true);
  });
});

describe('#269 布局不变式：module add 写的 lock 就是 runDeploy 读的 lock', () => {
  it('init + module add + runDeploy（替身 CF / 产物形态）→ 不漂移、装配成功、台账写回实例目录', async () => {
    const artifactsRoot = fileURLToPath(new URL('../dist/artifacts', import.meta.url));
    if (!existsSync(join(artifactsRoot, 'manifest.json'))) return; // 未构建产物时跳过（与 module-pack 测试 7 同款）

    await run(opts(['init', 'demo']));
    const layout = instanceLayout(join(cwd, 'demo'));
    writeFileSync(
      layout.configPath,
      readFileSync(layout.configPath, 'utf8').replace('"modules": ["hello"]', '"modules": []'),
    );
    const add = opts(['module', 'add', `file:${HELLO_DIR}`]);
    await run(add);
    expect(add.exitCode()).toBe(0);
    expect(existsSync(layout.lockPath)).toBe(true);

    const { makeCfRestFake } = await import('../../../deploy/cloudflare/test/helpers/cf-rest-fake');
    const { RestClient } = await import('@unself/deploy-cloudflare');
    const { runDeploy } = await import('../src/deploy');
    const fake = makeCfRestFake();
    const JWKS = JSON.stringify({
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
    const result = await runDeploy({
      instancePath: layout.instanceDir,
      engineOverrides: {
        artifactRoot: artifactsRoot,
        client: new RestClient({ token: 't', fetchImpl: fake.fetchImpl }),
        http: {
          smoke: async (_b: string, mods: Array<{ id: string; baseUrl: string }>) => [
            { name: 'core-api', url: 'https://x/api/health', ok: true, status: 200 },
            ...mods.map((m) => ({ name: `module:${m.id}`, url: `${m.baseUrl}/api/health`, ok: true, status: 200 })),
          ],
          themeCheck: async () => [],
        },
        fetchJwks: async () => JWKS,
      },
    });
    expect(result.baseUrl).toContain('workers.dev');

    // lock 与资源台账都写在实例目录内（引擎读到的就是 module add 写的那一份）
    const lock = JSON.parse(readFileSync(layout.lockPath, 'utf8')) as {
      modules: Record<string, { source: string }>;
      resources?: unknown;
    };
    expect(lock.modules.hello?.source).toBe(`file:${HELLO_DIR}`);
    expect(lock.resources).toBeDefined();
  }, 120_000);
});
