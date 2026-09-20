// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #270 `unself module remove` / `unself module validate` CLI 行为测试。
 *
 * 验收对照：
 * - `module remove <id>`：不在 config 拒不动作；在 config → 引擎卸载 + 同步移除 config 条目（贴真库/真文件）；
 * - `module validate [目录]`：过 → 退出码 0；不过 → 退出码 1 + §7 诊断；
 * - 文案串味修复：部署语义提示只在 `deploy` 路径出现，`module remove` 失败不再贴。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../src/cli';
import { instanceLayout } from '../src/lib/dir';
import { removeModuleFromConfigText } from '../src/lib/config-edit';

let home: string;
let cwd: string;
let out: string[];
let errs: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'unself-270-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'unself-270-cwd-'));
  out = [];
  errs = [];
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function opts(argv: string[], extra?: Partial<RunOptions>): RunOptions {
  return {
    argv,
    env: {},
    home,
    cwd,
    log: (l) => out.push(l),
    err: (l) => errs.push(l),
    ...extra,
  };
}

describe('#270 config-edit：移除模块条目', () => {
  it('移除对象条目并保留注释；未命中不改动', () => {
    const text = '{\n  // 注释保留\n  "modules": ["hello", {"id":"todo","source":"file:./x"}],\n  "domain": ""\n}\n';
    const r = removeModuleFromConfigText(text, 'todo');
    expect(r.removed).toBe(true);
    expect(r.text).toContain('// 注释保留');
    expect(r.text).toContain('"modules": ["hello"]');
    expect(r.text).not.toContain('todo');
    const miss = removeModuleFromConfigText(text, 'ghost');
    expect(miss.removed).toBe(false);
    expect(miss.text).toBe(text);
  });
});

describe('#270 module remove（真引擎 + REST 替身）', () => {
  it('卸载：删清单表 + 清记账 + 移 config 条目 + 更新 lock', async () => {
    await run(opts(['init', 'demo']));
    const layout = instanceLayout(join(cwd, 'demo'));

    const { makeCfRestFake } = await import('./engine/helpers/cf-rest-fake');
    const { RestClient } = await import('../src/engine/index');
    const { createCoreControlPlane } = await import('../src/engine/index');
    const fake = makeCfRestFake({
      existingD1: ['unself-core', 'unself-modules'],
      existingWorkers: ['unself-module-hello'],
      existingLedger: { unself_migrations_hello: ['0001_init.sql'] },
    });
    const client = new RestClient({ token: 't', fetchImpl: fake.fetchImpl });
    const coreUuid = (await (await import('../src/engine/index')).d1List(client, 'f7351bdd-acc0-0000-0000-000000000001')).find(
      (d) => d.name === 'unself-core',
    )!.uuid;
    await createCoreControlPlane(client, 'f7351bdd-acc0-0000-0000-000000000001', coreUuid).upsertModule({
      id: 'hello',
      enabled: true,
      manifest: {
        id: 'hello',
        version: '0.1.0',
        runtimes: ['worker'],
        route: '/m/hello',
        entry: 'https://team.example.com/m/hello/',
        storage: { accepts: ['shared'], declaration: 'shared' },
        tables: ['hello_counter'],
      },
    });

    const { removeModuleFromInstance } = await import('../src/deploy');
    const result = await removeModuleFromInstance({
      instancePath: layout.instanceDir,
      moduleId: 'hello',
      engineOverrides: {
        client,
        configOverride: { domain: '', modules: [], storage: { provider: 'r2', bucket: 'unself-storage' } },
      },
    });

    expect(result.tablesDropped).toEqual(['hello_counter']);
    expect(result.ledgerTable).toBe('unself_migrations_hello');
    expect(result.removedFromRegistry).toBe(true);
    expect(result.configRemoved).toBe(true);

    // config 条目真被移除；lock 模块条目真被移除
    expect(readFileSync(layout.configPath, 'utf8')).not.toContain('hello');
    const lock = JSON.parse(readFileSync(layout.lockPath, 'utf8')) as { modules: Record<string, unknown> };
    expect(lock.modules.hello).toBeUndefined();
  });

  it('id 不在 config：抛人话错且零副作用（不发任何 CF 请求）', async () => {
    await run(opts(['init', 'demo']));
    const layout = instanceLayout(join(cwd, 'demo'));
    const before = readFileSync(layout.configPath, 'utf8');
    const { removeModuleFromInstance } = await import('../src/deploy');
    await expect(removeModuleFromInstance({ instancePath: layout.instanceDir, moduleId: 'ghost' })).rejects.toThrow(
      /没有「ghost」/,
    );
    expect(readFileSync(layout.configPath, 'utf8')).toBe(before);
  });
});

describe('#270 module remove CLI 接线与文案', () => {
  it('module remove 走注入桥：退出码 0 + 打印卸载摘要', async () => {
    await run(opts(['init', 'demo']));
    const o = opts(['module', 'remove', 'hello'], {
      moduleRemove: async () => ({
        moduleId: 'hello',
        level: 'shared',
        tablesDropped: ['hello_counter'],
        ledgerTable: 'unself_migrations_hello',
        routeRemoved: false,
        workerDeleted: true,
        removedFromRegistry: true,
        lockUpdated: true,
        configRemoved: true,
      }),
    });
    await run(o);
    const text = out.join('\n');
    expect(text).toContain('已卸载模块：hello（落点 shared）');
    expect(text).toContain('已删表（按 tables 清单）：hello_counter');
    expect(text).toContain('已清记账表：unself_migrations_hello');
  });

  it('module remove 失败不贴部署语义提示；deploy 失败仍贴', async () => {
    await run(opts(['init', 'demo']));
    const o1 = opts(['module', 'remove', 'hello'], {
      moduleRemove: async () => {
        throw new Error('boom-remove');
      },
    });
    await run(o1);
    expect(errs.join('\n')).toContain('boom-remove');
    expect(errs.join('\n')).not.toContain('多数失败可直接重跑');

    errs = [];
    const o2 = opts(['deploy'], {
      deployNineSteps: async () => {
        throw new Error('boom-deploy');
      },
    });
    await run(o2);
    expect(errs.join('\n')).toContain('多数失败可直接重跑');
  });
});

describe('#270 module validate', () => {
  function writePassFixture(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      `${JSON.stringify(
        {
          id: 'demo',
          version: '1.0.0',
          runtimes: ['worker'],
          route: '/m/demo',
          entry: 'https://demo.example.com/',
          permissions: ['storage'],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(dir, 'worker.js'), 'export default { fetch: () => new Response("ok") };\n');
    writeFileSync(join(dir, 'LICENSE'), 'AGPL-3.0-only\n');
  }

  it('合格模块目录：退出码 0（六类检查通过）', async () => {
    const dir = join(cwd, 'ok-mod');
    writePassFixture(dir);
    const o = opts(['module', 'validate', dir]);
    await run(o);
    expect(errs.join('\n')).toBe('');
    expect(out.join('\n')).toContain('✓ 模块校验通过：demo v1.0.0');
  });

  it('包根 package.json 版本与 manifest 一致：仍通过（#285 C3 不误伤）', async () => {
    const dir = join(cwd, 'ok-pkg');
    writePassFixture(dir);
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'demo', version: '1.0.0', files: ['manifest.json'], license: 'AGPL-3.0-only' }, null, 2)}\n`,
    );
    const o = opts(['module', 'validate', dir]);
    await run(o);
    expect(errs.join('\n')).toBe('');
    expect(out.join('\n')).toContain('✓ 模块校验通过：demo v1.0.0');
  });

  it('包根 package.json 版本与 manifest 不一致：退出码非 0（#285 C3 报红）', async () => {
    const dir = join(cwd, 'bad-pkg-version');
    writePassFixture(dir);
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'demo', version: '2.0.0', files: ['manifest.json'], license: 'AGPL-3.0-only' }, null, 2)}\n`,
    );
    const o = opts(['module', 'validate', dir]);
    await run(o);
    expect(out.join('\n')).toContain('[error]');
    expect(out.join('\n') + errs.join('\n')).toContain('不一致');
    expect(errs.join('\n')).toContain('✗ 模块校验未通过');
  });

  it('包根 package.json 不是合法 JSON：发布前拦下', async () => {
    const dir = join(cwd, 'bad-pkg-json');
    writePassFixture(dir);
    writeFileSync(join(dir, 'package.json'), '{ not json\n');
    const o = opts(['module', 'validate', dir]);
    await run(o);
    expect(out.join('\n') + errs.join('\n')).toContain('package.json');
    expect(errs.join('\n')).toContain('✗ 模块校验未通过');
  });

  it('缺 LICENSE/worker.js：退出码 1 + [error] 诊断', async () => {
    const dir = join(cwd, 'bad-mod');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      `${JSON.stringify(
        { id: 'demo', version: '1.0.0', runtimes: ['worker'], route: '/m/demo', entry: 'https://demo.example.com/' },
        null,
        2,
      )}\n`,
    );
    const o = opts(['module', 'validate', dir]);
    await run(o);
    expect(out.join('\n')).toContain('[error]');
    expect(errs.join('\n')).toContain('✗ 模块校验未通过');
  });

  it('缺 manifest：退出码 1 + 人话错；且不贴部署语义提示', async () => {
    const dir = join(cwd, 'empty-mod');
    mkdirSync(dir, { recursive: true });
    const o = opts(['module', 'validate', dir]);
    await run(o);
    expect(errs.join('\n')).toContain('缺 manifest');
    expect(errs.join('\n')).not.toContain('多数失败可直接重跑');
  });

  it('目录不存在也是人话错（不是裸栈）', async () => {
    const o = opts(['module', 'validate', join(cwd, 'nope')]);
    await run(o);
    expect(errs.join('\n')).toContain('缺 manifest');
  });
});
