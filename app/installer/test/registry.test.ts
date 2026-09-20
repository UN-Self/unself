// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyRegistry,
  loadRegistry,
  refreshRegistry,
  registerInstance,
  registryPath,
  removeInstance,
  resolveCurrent,
  saveRegistry,
} from '../src/lib/registry';

let home: string;
let dirA: string;
let dirB: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'unself-reg-test-'));
  dirA = join(home, 'srv', 'alpha');
  dirB = join(home, 'srv', 'beta');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('registryPath', () => {
  it('拼出 ~/.unself/instances.json', () => {
    expect(registryPath('/home/demo')).toBe(join('/home/demo', '.unself', 'instances.json'));
  });
});

describe('register → save → load 往返', () => {
  it('落盘往返保形状，instances 键排序', () => {
    let reg = emptyRegistry();
    reg = registerInstance(reg, 'zeta', dirB);
    reg = registerInstance(reg, 'alpha', dirA);
    reg = registerInstance(reg, 'beta', join(home, 'srv', 'gamma'));
    expect(Object.keys(reg.instances)).toEqual(['alpha', 'beta', 'zeta']);

    saveRegistry(reg, home);
    const loaded = loadRegistry(home);
    expect(loaded).toEqual(reg);
    expect(loaded.version).toBe(1);
    expect(loaded.current).toBeNull();
  });

  it('缺失文件 → 空注册表；解析失败 → 人话 Error 不静默重置', () => {
    expect(loadRegistry(home)).toEqual(emptyRegistry());

    mkdirSync(join(home, '.unself'), { recursive: true });
    writeFileSync(registryPath(home), '{ broken json');
    expect(() => loadRegistry(home)).toThrowError(/注册表解析失败/);
    try {
      loadRegistry(home);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain(registryPath(home));
    }
    expect(existsSync(registryPath(home))).toBe(true); // 未被静默重置
  });
});

describe('registerInstance', () => {
  it('同名换路径 = 覆盖（切换语义），其他条目保留', () => {
    let reg = emptyRegistry();
    reg = registerInstance(reg, 'alpha', dirA);
    reg = registerInstance(reg, 'beta', dirB);
    reg = registerInstance(reg, 'alpha', join(home, 'srv', 'gamma'));
    expect(reg.instances['alpha']).toBe(join(home, 'srv', 'gamma'));
    expect(reg.instances['beta']).toBe(dirB);
  });

  it('名字不合法或相对路径 → 人话 Error', () => {
    const reg = emptyRegistry();
    expect(() => registerInstance(reg, 'Alpha', dirA)).toThrowError(/实例名不合法/);
    expect(() => registerInstance(reg, '-bad', dirA)).toThrowError(/实例名不合法/);
    expect(() => registerInstance(reg, 'a'.repeat(65), dirA)).toThrowError(/实例名不合法/);
    expect(() => registerInstance(reg, 'ok', 'relative/path')).toThrowError(/绝对路径/);
  });
});

describe('removeInstance', () => {
  it('剔除条目；current 指向它则置 null；purgeDir 返回 toPurge 且不动 fs', () => {
    let reg = emptyRegistry();
    reg = registerInstance(reg, 'alpha', dirA);
    reg = registerInstance(reg, 'beta', dirB);
    reg = { ...reg, current: 'alpha' };

    const gone = removeInstance(reg, 'alpha', { purgeDir: true });
    expect(gone.reg.instances).toEqual({ beta: dirB });
    expect(gone.reg.current).toBeNull();
    expect(gone.toPurge).toBe(dirA);
    expect(existsSync(dirA)).toBe(true); // fs 由调用方执行

    const keep = removeInstance(reg, 'beta');
    expect(keep.reg.current).toBe('alpha');
    expect(keep.toPurge).toBeUndefined();
  });
});

describe('resolveCurrent', () => {
  const reg = () => {
    let r = emptyRegistry();
    r = registerInstance(r, 'alpha', dirA);
    r = registerInstance(r, 'beta', dirB);
    return r;
  };

  it('优先级 1：UNSELF_INSTANCE 名字优先', () => {
    const r = { ...reg(), current: 'beta' };
    expect(resolveCurrent(r, { UNSELF_INSTANCE: 'alpha' }, home)).toEqual({ name: 'alpha', path: dirA });
  });

  it('优先级 1b：UNSELF_INSTANCE 绝对路径匹配已注册实例', () => {
    const r = reg();
    expect(resolveCurrent(r, { UNSELF_INSTANCE: dirB }, home)).toEqual({ name: 'beta', path: dirB });
  });

  it('UNSELF_INSTANCE 查不到 → 人话 Error 列出已注册实例', () => {
    const r = reg();
    expect(() => resolveCurrent(r, { UNSELF_INSTANCE: 'ghost' }, home)).toThrowError(/UNSELF_INSTANCE=ghost/);
    try {
      resolveCurrent(r, { UNSELF_INSTANCE: 'ghost' }, home);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('alpha');
      expect((err as Error).message).toContain('beta');
    }
  });

  it('优先级 2：reg.current', () => {
    const r = { ...reg(), current: 'beta' };
    expect(resolveCurrent(r, {}, home)).toEqual({ name: 'beta', path: dirB });
  });

  it('优先级 3：cwd 在某实例路径内自动选（更深前缀优先）', () => {
    const r = reg();
    const nested = join(dirA, 'generated');
    expect(resolveCurrent(r, {}, nested)).toEqual({ name: 'alpha', path: dirA });
  });

  it('优先级 4：恰一个实例自动选；0 或 ≥2 且无其他信号 → null', () => {
    let one = emptyRegistry();
    one = registerInstance(one, 'alpha', dirA);
    expect(resolveCurrent(one, {}, home)).toEqual({ name: 'alpha', path: dirA });

    expect(resolveCurrent(emptyRegistry(), {}, home)).toBeNull();
    expect(resolveCurrent(reg(), {}, home)).toBeNull();
  });
});

describe('refreshRegistry', () => {
  it('剔除消失路径，current 失效置 null', () => {
    let reg = emptyRegistry();
    reg = registerInstance(reg, 'alpha', dirA);
    reg = registerInstance(reg, 'beta', dirB);
    reg = { ...reg, current: 'alpha' };

    const refreshed = refreshRegistry(reg, (p) => p !== dirA);
    expect(refreshed.instances).toEqual({ beta: dirB });
    expect(refreshed.current).toBeNull();
  });

  it('全部存在 → 原样保留（含 current）', () => {
    let reg = emptyRegistry();
    reg = registerInstance(reg, 'alpha', dirA);
    reg = { ...reg, current: 'alpha' };
    expect(refreshRegistry(reg, () => true)).toEqual(reg);
  });
});

describe('saveRegistry 自嵌套守卫', () => {
  it('注册表路径落进已注册实例目录内部 → Error 拒写', () => {
    let reg = emptyRegistry();
    reg = registerInstance(reg, 'alpha', home); // home 本身是实例目录 → ~/.unself 在其内部
    expect(() => saveRegistry(reg, home)).toThrowError(/自嵌套/);
    expect(existsSync(registryPath(home))).toBe(false);
  });
});

describe('形状秘密断言', () => {
  it('往返 JSON 不含秘密字段', () => {
    let reg = emptyRegistry();
    reg = registerInstance(reg, 'alpha', dirA);
    reg = { ...reg, current: 'alpha' };
    saveRegistry(reg, home);
    const raw = readFileSync(registryPath(home), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['current', 'instances', 'version']);
    expect(raw.toLowerCase()).not.toMatch(/secret|token|password|key/);
  });
});

describe('默认 home 参数', () => {
  it('registryPath 无参 = 真实家目录下的 ~/.unself/instances.json', () => {
    expect(registryPath()).toBe(join(homedir(), '.unself', 'instances.json'));
  });
});
