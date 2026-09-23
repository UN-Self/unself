// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLI 行为测试：argv/env/home/cwd 全注入，零 process 副作用（不碰真实 ~/.unself）。
 * 覆盖：init/list(--json)/use/current/destroy/未知命令/help；路径可见性（pathline 首尾出现）；
 * 红灯验证：变异 use 未写 current、destroy 未删目录 → 用例必红（T7 汇编引用）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, run, defaultInstanceName, type RunOptions } from '../src/cli';
import { formatIdentity } from '../src/lib/identity';
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

  it('--version / -v 识别为命令（#287： KNOWN_COMMANDS 缺了它就会落回「未知命令」）', () => {
    expect(parseArgs(['--version']).cmd).toBe('--version');
    expect(parseArgs(['-v']).cmd).toBe('-v');
  });
});

describe('--version（#287，决策 #80：三项身份可自证）', () => {
  /** 安装器包版本真值：按包名定位 app/installer 的 package.json（相对本测试文件上两级，不硬算仓库根）。 */
  function installerVersion(): string {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
    if (pkg.name !== '@unself/installer' || !pkg.version) throw new Error('安装器 package.json 形状变了');
    return pkg.version;
  }

  /** 三项身份的行为断言（--version 与收尾屏共用）：版本、40 位 commit、workbench 版本，且无「未知命令」。 */
  function expectThreeIdentityLines(text: string): void {
    expect(text).toContain(`unself 版本：v${installerVersion()}`);
    expect(text).toMatch(/commit [0-9a-f]{40}\b|commit dev\b/);
    expect(text).toMatch(/@unself\/workbench v\d+\.\d+\.\d+/);
    expect(text).not.toContain('未知命令');
  }

  it('--version 输出三项且零副作用（不需要当前实例/注册表）', async () => {
    await run(opts(['--version']));
    expect(errs).toEqual([]);
    expectThreeIdentityLines(out.join('\n'));
  });

  it('-v 同口径', async () => {
    await run(opts(['-v']));
    expect(errs).toEqual([]);
    expectThreeIdentityLines(out.join('\n'));
  });

  it('身份格式化：workbench 解析失败 → 「不可用 + 原因」占位，不留空不抛', () => {
    const text = formatIdentity({
      installer: { version: '0.0.0-test', commit: 'dev' },
      workbenchVersion: null,
      workbenchProblem: 'node_modules 里没这个包',
    });
    expect(text).toContain('unself 版本：v0.0.0-test');
    expect(text).toContain('平台产物不可用：@unself/workbench（node_modules 里没这个包）');
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

    // 路径可见性：echoPathline 在输出末尾给出实例目录（一次，不重复打印）
    expect(out.filter((l) => l === pathline(inst))).toHaveLength(1);

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
    expect(out.filter((l) => l === pathline(join(cwd, 'unself'))).length).toBe(1);

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

describe('零克隆主路径：没有任何实例也能直接进向导（README「一条命令」）', () => {
  function spyWizard(seen: string[]): Partial<RunOptions> {
    return {
      startWizard: async (o) => {
        seen.push(o.instancePath);
        return 0;
      },
    };
  }

  it('全新目录跑 `wizard` → 就地建实例、设为 current、向导拿到该实例目录', async () => {
    const seen: string[] = [];
    await run(opts(['wizard'], spyWizard(seen)));
    expect(errs).toEqual([]);
    const inst = join(cwd, 'unself');
    expect(seen).toEqual([inst]);
    expect(existsSync(join(inst, 'unself.config.jsonc'))).toBe(true);
    // 实例名 = 目录名（净化后）；注册表指向刚建的实例目录
    const reg = loadRegistry(home);
    expect(reg.current).toBe(defaultInstanceName(cwd));
    expect(reg.instances[reg.current as string]).toBe(inst);
  });

  it('缺省命令（无参数）同口径：不再报「没有当前实例」', async () => {
    const seen: string[] = [];
    await run(opts([], spyWizard(seen)));
    expect(errs).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('`wizard <名字>` → 用该名字建实例（帮助文案承诺的形态）', async () => {
    const seen: string[] = [];
    await run(opts(['wizard', 'demo'], spyWizard(seen)));
    expect(errs).toEqual([]);
    expect(seen).toEqual([join(cwd, 'demo', 'unself')]);
    expect(loadRegistry(home).current).toBe('demo');
  });

  it('已注册同名实例（不在当前目录下、当前指针为空且多于一个）→ 切过去，不重复建目录', async () => {
    await run(opts(['init', 'demo', join(cwd, 'elsewhere')]));
    await run(opts(['init', 'other', join(cwd, 'other-root')]));
    // 模拟「注册表里还在、但当前指针丢了」
    saveRegistry({ ...loadRegistry(home), current: null }, home);
    const seen: string[] = [];
    await run(opts(['wizard', 'demo'], spyWizard(seen)));
    expect(seen).toEqual([join(cwd, 'elsewhere', 'unself')]);
    expect(loadRegistry(home).current).toBe('demo');
    expect(out.join('')).toContain('切换到你已注册的实例');
    expect(existsSync(join(cwd, 'unself'))).toBe(false);
  });

  it('已有 current 实例时不自举、不劫持（向导照用当前实例）', async () => {
    await run(opts(['init', 'other', join(cwd, 'other-root')]));
    const seen: string[] = [];
    await run(opts(['wizard'], spyWizard(seen)));
    expect(seen).toEqual([join(cwd, 'other-root', 'unself')]);
    expect(existsSync(join(cwd, 'unself'))).toBe(false);
  });

  it('`deploy` 保持原口径：没有实例就人话报错，不隐式建目录（CI/逃生门）', async () => {
    await run(opts(['deploy']));
    expect(errs.join('\n')).toContain('没有当前实例');
    expect(existsSync(join(cwd, 'unself'))).toBe(false);
  });
});
