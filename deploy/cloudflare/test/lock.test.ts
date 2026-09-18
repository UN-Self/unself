// SPDX-License-Identifier: AGPL-3.0-only
/**
 * unself.lock 测试（issue #245，决策 #60）：
 * - 模型 roundtrip + 坏结构人话报错；
 * - 计划构建三动作（reuse/added/changed/removed）：重跑一律用 lock、换源=显式升级；
 * - manifestHash 稳定序；SRI 与包字节绑定；
 * - 【红灯】篡改包字节 → integrity 不匹配 → 拒绝安装（failures 非空）；
 * - 【红灯】manifest 变了版本没变 → manifestHash 不匹配 → 拒绝。
 */
import { describe, expect, it } from 'vitest';
import {
  builtinSource,
  buildLockPlan,
  emptyLock,
  formatIntegrityFailures,
  formatLockDiff,
  LockFileSchema,
  manifestHashOf,
  parseLockText,
  serializeLock,
  stableStringify,
  verifyLockIntegrity,
  type LockEntry,
} from '../src/lock';
import { sriFromBuffer } from '../src/sources';

const entry = (over: Partial<LockEntry>): LockEntry => ({
  source: 'npm:@acme/todo@1.2.0',
  version: '1.2.0',
  integrity: 'sha512-AAAA',
  manifestHash: 'a'.repeat(64),
  contractVersion: '1.0',
  ...over,
});

const baseLock = (mods: Record<string, LockEntry>) => ({
  lockVersion: 1 as const,
  generatedAt: '2026-09-18T00:00:00.000Z',
  modules: mods,
});

describe('lock 模型（roundtrip）', () => {
  it('serialize → parse 恒等', () => {
    const lock = baseLock({ todo: entry({}) });
    expect(parseLockText(serializeLock(lock))).toEqual(lock);
  });
  it('坏 JSON / 坏结构 → 人话报错（不裸抛）', () => {
    expect(() => parseLockText('not json')).toThrow(/合法 JSON/);
    expect(() => parseLockText('{"lockVersion":2,"generatedAt":"x","modules":{}}')).toThrow(/结构非法/);
    expect(() => parseLockText('{"lockVersion":1,"generatedAt":"x","modules":{"todo":{"source":"npm:x@1.0.0"}}}')).toThrow(/结构非法/);
  });
  it('integrity SRI 形状校验（sha512-<base64>）', () => {
    const bad = baseLock({ todo: entry({ integrity: 'md5-xxx' as never }) });
    expect(LockFileSchema.safeParse(bad).success).toBe(false);
  });
});

describe('manifestHash（稳定序）', () => {
  it('键序无关：同一 manifest 两种键序同哈希', () => {
    const a = { id: 'todo', version: '1.2.0', runtimes: ['worker'], route: '/m/todo', entry: 'http://x/' };
    const b = { entry: 'http://x/', route: '/m/todo', runtimes: ['worker'], version: '1.2.0', id: 'todo' };
    expect(manifestHashOf(a)).toBe(manifestHashOf(b));
  });
  it('内容变了（哪怕版本没变）哈希必变', () => {
    const a = { id: 'todo', version: '1.2.0' };
    const b = { id: 'todo', version: '1.2.0', description: 'now with docs' };
    expect(manifestHashOf(a)).not.toBe(manifestHashOf(b));
  });
  it('stableStringify：嵌套与数组', () => {
    expect(stableStringify({ b: 1, a: [2, { z: 3, y: 4 }] })).toBe('{"a":[2,{"y":4,"z":3}],"b":1}');
  });
});

describe('buildLockPlan（重跑用 lock、换源=显式）', () => {
  const lock = baseLock({
    todo: entry({}),
    hello: entry({ source: 'builtin:hello', integrity: undefined, version: '0.1.0' }),
    old: entry({ source: 'official:old', version: '0.0.9' }),
  });

  it('config 与 lock 完全一致 → 全 reuse（重跑不重解析）', () => {
    const plan = buildLockPlan({
      entries: [
        { id: 'todo', source: 'npm:@acme/todo@1.2.0' },
        { id: 'hello' },
      ],
      lock,
    });
    expect(plan.reuse.map((r) => r.id)).toEqual(['todo', 'hello']);
    expect(plan.resolve).toEqual([]);
    expect(plan.removed.map((r) => r.id)).toEqual(['old']);
    expect(driftOf(plan)).toBe(true); // old 被移除 = 漂移
  });

  it('无 lock（首装）→ 全 added', () => {
    const plan = buildLockPlan({ entries: [{ id: 'todo', source: 'npm:@acme/todo@1.2.0' }], lock: emptyLock() });
    expect(plan.resolve.map((r) => r.id)).toEqual(['todo']);
    expect(plan.resolve[0]!.action).toBe('added');
  });

  it('【红灯】lock 版本与 config 不一致（换源）→ changed 重解析，不静默复用', () => {
    const plan = buildLockPlan({
      entries: [{ id: 'todo', source: 'npm:@acme/todo@2.0.0' }],
      lock,
    });
    expect(plan.reuse).toEqual([]);
    expect(plan.resolve.map((r) => r.id)).toEqual(['todo']);
    expect(plan.resolve[0]!.action).toBe('changed');
    expect(plan.resolve[0]!.previous?.version).toBe('1.2.0');
  });

  it('builtin 模块合成 source（builtin:<id>）进 lock', () => {
    expect(builtinSource('hello')).toBe('builtin:hello');
    const plan = buildLockPlan({ entries: [{ id: 'hello' }], lock: emptyLock() });
    expect(plan.resolve[0]!.source).toBe('builtin:hello');
  });

  it('diff 文案：三种动作可读', () => {
    const plan = buildLockPlan({
      entries: [
        { id: 'todo', source: 'npm:@acme/todo@2.0.0' },
        { id: 'hello' },
        { id: 'newmod', source: 'https://example.com/newmod-0.1.0.tgz' },
      ],
      lock,
    });
    const lines = formatLockDiff(plan);
    expect(lines.some((l) => l.startsWith('~ todo：') && l.includes('1.2.0') && l.includes('2.0.0'))).toBe(true);
    expect(lines.some((l) => l.startsWith('+ newmod'))).toBe(true);
    expect(lines.some((l) => l.startsWith('- old'))).toBe(true);
    expect(lines.some((l) => l.startsWith('- hello') || l.startsWith('~ hello'))).toBe(false);
  });
});

/** plan 是否有漂移（helper：不导出 driftNotice 的重复实现）。 */
function driftOf(plan: { items: Array<{ action: string }>; removed: unknown[] }): boolean {
  return plan.items.some((i) => i.action !== 'reuse') || plan.removed.length > 0;
}

describe('verifyLockIntegrity（哈希不匹配直接拒绝）', () => {
  const manifest = { id: 'todo', version: '1.2.0', route: '/m/todo', entry: 'http://x/', runtimes: ['worker'] };
  const files = {
    'manifest.json': Buffer.from(JSON.stringify(manifest)),
    'worker.js': Buffer.from('export default {};'),
  };
  const lock = baseLock({
    todo: entry({
      integrity: sriFromBuffer(
        Buffer.concat([
          Buffer.from('manifest.json\0'),
          files['manifest.json']!,
          Buffer.from([1]),
          Buffer.from('worker.js\0'),
          files['worker.js']!,
          Buffer.from([1]),
        ]),
      ),
      manifestHash: manifestHashOf(manifest),
    }),
  });
  const plan = buildLockPlan({ entries: [{ id: 'todo', source: 'npm:@acme/todo@1.2.0' }], lock });

  it('一致 → 零失败', () => {
    const failures = verifyLockIntegrity({
      plan,
      manifests: { todo: manifest },
      packageFiles: { todo: files },
    });
    expect(failures).toEqual([]);
  });

  it('【红灯】篡改 tarball（worker.js 换字节）→ integrity 不匹配 → 拒绝安装', () => {
    const tampered = { ...files, 'worker.js': Buffer.from('export default { pwned: true };') };
    const failures = verifyLockIntegrity({
      plan,
      manifests: { todo: manifest },
      packageFiles: { todo: tampered },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.kind).toBe('integrity');
    expect(formatIntegrityFailures(failures)[0]).toContain('拒绝安装');
  });

  it('【红灯】manifest 变了（版本没变）→ manifestHash 不匹配 → 拒绝安装', () => {
    const changedManifest = { ...manifest, description: 'sneaky change' };
    const failures = verifyLockIntegrity({
      plan,
      manifests: { todo: changedManifest },
      packageFiles: { todo: files },
    });
    expect(failures.some((f) => f.kind === 'manifestHash')).toBe(true);
  });

  it('downloadedSris 优先：下载时算的 SRI 与 lock 比对', () => {
    const failures = verifyLockIntegrity({
      plan,
      manifests: { todo: manifest },
      downloadedSris: { todo: 'sha512-BBBB' },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.kind).toBe('integrity');
  });

  it('reuse 模块 manifest 缺失 → 视为失败（不静默放行）', () => {
    const failures = verifyLockIntegrity({ plan, manifests: {} });
    expect(failures[0]!.kind).toBe('manifestHash');
    expect(failures[0]!.actual).toBe('(manifest 缺失)');
  });
});
