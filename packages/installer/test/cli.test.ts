// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLI 行为测试：argv/env/home/cwd 全注入，零 process 副作用（不碰真实 ~/.unself）。
 * 覆盖：init/list(--json)/use/current/destroy/未知命令/help；路径可见性（pathline 首尾出现）；
 * 红灯验证：变异 use 未写 current、destroy 未删目录 → 用例必红（T7 汇编引用）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, run, type RunOptions } from '../src/cli';
import {
  emptyRegistry,
  loadRegistry,
  pathline,
  registerInstance,
  registryPath,
  saveRegistry,
} from '../src/index';

let home: string;
let cwd: string;
let out: string[];
let errs: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'unself-cli-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'unself-cli-cwd-'));
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

describe('parseArgs', () => {
  it('缺省命令 = wizard；--json/--purge 开关剥出', () => {
    expect(parseArgs([])).toMatchObject({ cmd: 'wizard', json: false, purge: false });
    expect(parseArgs(['list', '--json'])).toMatchObject({ cmd: 'list', json: true });
    expect(parseArgs(['destroy', 'a', '--purge'])).toMatchObject({ cmd: 'destroy', args: ['a'], purge: true });
  });
});

describe('init → list → use → current → destroy 全链', () => {
  it('init 创建目录并设 current；输出首尾都有实例目录（路径可见）', async () => {
    await run(opts(['init', 'demo', cwd]));
    expect(errs).toEqual([]);
    const inst = join(cwd, 'unself'); // 决策 #53：实例 = 用户选定目录下的 unself/
    expect(existsSync(inst)).toBe(true);
    expect(existsSync(join(inst, 'unself.config.jsonc'))).toBe(true);
    expect(existsSync(join(inst, 'generated'))).toBe(true);

    // 路径可见性：echoPathline 两行
    expect(out.filter((l) => l === pathline(inst)).length).toBe(2);

    // 注册表落盘
    const reg = loadRegistry(home);
    expect(reg.current).toBe('demo');
    expect(reg.instances['demo']).toBe(inst);
  });

  it('list 列出全部实例（* 标 current）；--json 供编排', async () => {
    await run(opts(['init', 'demo', cwd]));
    await run(opts(['init', 'other', join(cwd, 'other-root')]));
    out.length = 0;

    await run(opts(['list']));
    expect(out.some((l) => l.startsWith('* other'))).toBe(true);
    expect(out.some((l) => l.includes('demo'))).toBe(true);
    expect(out.some((l) => l.includes('实例注册表'))).toBe(true);
    expect(out.some((l) => l.includes(registryPath(home)))).toBe(true);

    out.length = 0;
    await run(opts(['list', '--json']));
    const parsed = JSON.parse(out.join('')) as { current: string; instances: Record<string, string> };
    expect(parsed.current).toBe('other');
    expect(Object.keys(parsed.instances).sort()).toEqual(['demo', 'other']);
  });

  it('use 切换并写 current；use 未知名字人话报错', async () => {
    await run(opts(['init', 'demo', cwd]));
    await run(opts(['init', 'other', join(cwd, 'other-root')]));
    out.length = 0;

    await run(opts(['use', 'demo']));
    expect(loadRegistry(home).current).toBe('demo');
    expect(out.filter((l) => l === pathline(join(cwd, 'unself'))).length).toBe(2);

    errs.length = 0;
    await run(opts(['use', 'ghost']));
    expect(errs[0]).toContain('未注册');
    expect(errs.join('')).toContain('demo');
  });

  it('current 显示当前实例；UNSELF_INSTANCE 环境变量优先', async () => {
    await run(opts(['init', 'demo', cwd]));
    await run(opts(['init', 'other', join(cwd, 'other-root')]));
    out.length = 0;

    await run(opts(['current']));
    expect(out.some((l) => l.includes('other'))).toBe(true);

    out.length = 0;
    await run(opts(['current'], { env: { UNSELF_INSTANCE: 'demo' } }));
    expect(out.some((l) => l.includes('demo'))).toBe(true);
  });

  it('destroy 注销；--purge 连目录删除；无 --purge 目录保留', async () => {
    await run(opts(['init', 'demo', cwd]));
    const inst = join(cwd, 'unself'); // 决策 #53：实例 = 用户选定目录下的 unself/
    await run(opts(['destroy', 'demo']));
    expect(loadRegistry(home).instances['demo']).toBeUndefined();
    expect(loadRegistry(home).current).toBeNull();
    expect(existsSync(inst)).toBe(true); // 目录保留

    await run(opts(['init', 'p2', join(cwd, 'p2root')]));
    await run(opts(['destroy', 'p2', '--purge']));
    expect(existsSync(join(cwd, 'p2root', 'p2'))).toBe(false);
  });
});

describe('异常路径（人话 + exit 1，不裸栈）', () => {
  it('未知命令', async () => {
    await run(opts(['frobnicate']));
    expect(errs[0]).toContain('未知命令');
  });

  it('空注册表 current → 指引 init', async () => {
    await run(opts(['current']));
    expect(errs.join('')).toContain('unself init');
  });

  it('help 输出用法', async () => {
    await run(opts(['help']));
    expect(out.join('')).toContain('wizard');
    expect(out.join('')).toContain('destroy');
  });
});

describe('红灯验证（T7 汇编引用：变异必红）', () => {
  it('守卫：saveRegistry 拒绝把注册表写进实例目录内（变异守卫 → 本用例红）', () => {
    const instHome = join(home, 'srv');
    mkdirSync(instHome, { recursive: true });
    const reg = registerInstance(emptyRegistry(), 'alpha', instHome);
    // 实例目录 = instHome 本身 → registryPath 落在其内部 → 必须拒写
    expect(() => saveRegistry(reg, instHome)).toThrowError(/自嵌套/);
  });

  it('守卫：destroy --purge 必须真删目录（变异 rmSync → 本用例红）', async () => {
    await run(opts(['init', 'demo', cwd]));
    const inst = join(cwd, 'unself'); // 决策 #53：实例目录 = <chosen>/unself
    await run(opts(['destroy', 'demo', '--purge']));
    expect(existsSync(inst)).toBe(false);
  });

  it('守卫：use 成功必须已写 current（变异 saveRegistry 跳过 → 本用例红）', async () => {
    await run(opts(['init', 'demo', cwd]));
    await run(opts(['init', 'other', join(cwd, 'other-root')]));
    await run(opts(['use', 'demo']));
    expect(loadRegistry(home).current).toBe('demo');
  });

  it('list --json 输出永不包含秘密字段（形状秘密断言）', async () => {
    await run(opts(['init', 'demo', cwd]));
    out.length = 0;
    await run(opts(['list', '--json']));
    expect(out.join('').toLowerCase()).not.toMatch(/secret|token|password/);
  });
});
