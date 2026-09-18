// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * 多实例注册表（#242）：~/.unself/instances.json，名字 → 实例目录路径。
 * 注册表本身不含任何秘密——只有名字与路径。
 *
 * 函数分两层：
 * - 纯函数（registerInstance / removeInstance / resolveCurrent / refreshRegistry）不做 fs，便于测试；
 * - IO 薄壳（registryPath / loadRegistry / saveRegistry）只做读写与原子落盘。
 */

export const INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface InstancesRegistry {
  version: 1;
  /** 当前选中实例名；无选中为 null */
  current: string | null;
  /** 名字 → 实例目录绝对路径，键按字典序 */
  instances: Record<string, string>;
}

/** 空注册表（version 1，无 current，无条目）。 */
export function emptyRegistry(): InstancesRegistry {
  return { version: 1, current: null, instances: {} };
}

/** 注册表落盘路径：join(home, '.unself', 'instances.json')。 */
export function registryPath(home: string = homedir()): string {
  return join(home, '.unself', 'instances.json');
}

/** 读注册表：文件缺失 → 空注册表；存在但解析失败 → 人话 Error（不静默重置）。 */
export function loadRegistry(home: string = homedir()): InstancesRegistry {
  const path = registryPath(home);
  if (!existsSync(path)) return emptyRegistry();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`注册表不可读：${path}（${(err as Error).message}）`);
  }
  try {
    const parsed = JSON.parse(raw) as InstancesRegistry;
    if (parsed.version !== 1 || typeof parsed.instances !== 'object' || parsed.instances === null) {
      throw new Error('version 或 instances 字段形状不符');
    }
    return { version: 1, current: parsed.current ?? null, instances: parsed.instances };
  } catch (err) {
    throw new Error(
      `注册表解析失败：${path} 不是合法的 instances.json（${(err as Error).message}）。请手工修复或删除该文件后重跑。`,
    );
  }
}

/**
 * 原子写注册表：先写同目录 tmp 再 rename。
 * 守卫：拒绝把注册表写进任何已注册实例目录内部（防自嵌套）。
 */
export function saveRegistry(reg: InstancesRegistry, home: string = homedir()): void {
  const target = registryPath(home);
  for (const [name, p] of Object.entries(reg.instances)) {
    const inside = resolve(p) + sep;
    if (target === resolve(p) || target.startsWith(inside)) {
      throw new Error(
        `拒绝写入：注册表路径 ${target} 落在已注册实例 ${name}（${p}）目录内部，会造成自嵌套`,
      );
    }
  }
  mkdirSync(registryDirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  renameSync(tmp, target);
}

function registryDirname(target: string): string {
  const i = target.lastIndexOf(sep);
  return i > 0 ? target.slice(0, i) : sep;
}

/**
 * 登记实例（纯函数）：同名换路径 = 覆盖（切换语义），其他条目保留；
 * instances 键排序；路径 resolve 成绝对路径。
 */
export function registerInstance(
  reg: InstancesRegistry,
  name: string,
  absPath: string,
): InstancesRegistry {
  if (!INSTANCE_NAME_RE.test(name)) {
    throw new Error(
      `实例名不合法：${name}（需匹配 ${INSTANCE_NAME_RE.source}：小写字母数字开头，可含连字符，≤64 位）`,
    );
  }
  if (!isAbsolute(absPath)) {
    throw new Error(`实例路径必须是绝对路径：${absPath}`);
  }
  const resolved = resolve(absPath);
  const instances: Record<string, string> = {};
  for (const k of Object.keys(reg.instances).sort()) {
    instances[k] = reg.instances[k] as string;
  }
  instances[name] = resolved;
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(instances).sort()) sorted[k] = instances[k] as string;
  return { version: 1, current: reg.current, instances: sorted };
}

/** 剔除实例（纯函数）。purgeDir=true 时返回 toPurge 路径，fs 删除由调用方执行。 */
export function removeInstance(
  reg: InstancesRegistry,
  name: string,
  opts: { purgeDir?: boolean } = {},
): { reg: InstancesRegistry; toPurge?: string } {
  const instances: Record<string, string> = {};
  let toPurge: string | undefined;
  for (const [k, v] of Object.entries(reg.instances)) {
    if (k === name) {
      if (opts.purgeDir) toPurge = v;
      continue;
    }
    instances[k] = v;
  }
  return {
    reg: { version: 1, current: reg.current === name ? null : reg.current, instances },
    toPurge,
  };
}

export interface ResolvedInstance {
  /** 实例名 */
  name: string;
  /** 实例目录绝对路径 */
  path: string;
}

/**
 * 解析当前实例（纯函数，不做 fs），优先级：
 * 1. env.UNSELF_INSTANCE（名字或绝对路径；查不到 → 人话 Error）
 * 2. reg.current
 * 3. cwd 落在某实例路径内 → 自动选该实例
 * 4. 恰有一个实例 → 自动选
 * 5. null
 */
export function resolveCurrent(
  reg: InstancesRegistry,
  env: { UNSELF_INSTANCE?: string },
  cwd: string,
): ResolvedInstance | null {
  const pick = (name: string): ResolvedInstance | null => {
    const p = reg.instances[name];
    if (!p) return null;
    return { name, path: p };
  };

  const override = env.UNSELF_INSTANCE;
  if (override) {
    if (reg.instances[override]) return { name: override, path: reg.instances[override] as string };
    if (isAbsolute(override)) {
      const target = resolve(override);
      for (const [name, p] of Object.entries(reg.instances)) {
        if (resolve(p) === target) return { name, path: target };
      }
    }
    throw new Error(
      `UNSELF_INSTANCE=${override} 未在注册表中找到（已注册：${Object.keys(reg.instances).join('、') || '无'}）`,
    );
  }

  if (reg.current) {
    const found = pick(reg.current);
    if (found) return found;
  }

  const cwdAbs = resolve(cwd);
  const cwdPrefix = cwdAbs + sep;
  let deepest: ResolvedInstance | null = null;
  for (const [name, p] of Object.entries(reg.instances)) {
    const abs = resolve(p);
    if (cwdAbs === abs || cwdPrefix.startsWith(abs + sep)) {
      if (!deepest || abs.length > resolve(deepest.path).length) deepest = { name, path: abs };
    }
  }
  if (deepest) return deepest;

  const names = Object.keys(reg.instances);
  if (names.length === 1) {
    const only = names[0] as string;
    return { name: only, path: reg.instances[only] as string };
  }
  return null;
}

/**
 * 对齐磁盘现状（纯函数）：exists(p)=false 的条目剔除；
 * current 指向被剔除条目时置 null。
 */
export function refreshRegistry(
  reg: InstancesRegistry,
  exists: (p: string) => boolean,
): InstancesRegistry {
  const instances: Record<string, string> = {};
  for (const [k, v] of Object.entries(reg.instances)) {
    if (exists(v)) instances[k] = v;
  }
  const current =
    reg.current && instances[reg.current] === reg.instances[reg.current] ? reg.current : null;
  return { version: 1, current, instances };
}
