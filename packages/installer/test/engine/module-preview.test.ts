// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 来源预览测试（issue #269 / T2）：
 *
 * 验收对照（/tmp/task-269-w2.md）：
 * ① loopback http 规则：http:// 仅 loopback（localhost / 127.0.0.1 / ::1）放行；其余明文 http 拒绝且文案含 HTTPS；
 * ② file: 目录形态 preview：id / version / permissions / storage 正确；
 * ③ 未知能力安装期（预览期）拒绝：词表外的能力名被点名；
 * ④ reuse 完整性收紧（决策 #60 补口子）：暂存包被清后重取包，lock integrity 不匹配 → 拒绝安装；
 * ⑤ reuse 的 manifestHash 检查：integrity 一致但 manifest 变了 → 拒绝。
 *
 * 红灯说明：④⑤ 若回退收紧逻辑（重取路径不比对 lock），测试必红——重取会静默接受新字节。
 */
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSource, sriFromBuffer } from '../../src/engine/sources';
import { manifestHashOf } from '../../src/engine/lock';
import { previewModuleSource } from '../../src/engine/module-preview';
import { resolveSources } from '../../src/engine/module-sources';

let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'unself-module-preview-'));
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// tarball 夹具：手工造 tar.gz（成员全在 package/ 前缀下 = npm 包形态）
// ---------------------------------------------------------------------------

/** manifest 基线（合法契约 v1 形态）。 */
const MANIFEST = {
  id: 'todo',
  version: '1.2.0',
  runtimes: ['worker'],
  route: '/m/todo',
  entry: 'http://localhost:8791/',
  description: '预览测试模块',
  permissions: ['storage'],
};

function manifestText(over?: Partial<typeof MANIFEST> & { storage?: Record<string, unknown>; tables?: string[] }): string {
  return JSON.stringify({ ...MANIFEST, ...over }, null, 2);
}

/** 手工造 tar.gz（复制自 module-sources-install.test.ts 的字节级写法，不 import 其私有 helper）。 */
function makePkgTarball(over?: { manifest?: string }): Buffer {
  const entries: Array<{ name: string; data: Buffer }> = [
    { name: 'package/manifest.json', data: Buffer.from(over?.manifest ?? manifestText()) },
    { name: 'package/worker.js', data: Buffer.from('export default {};\n') },
    { name: 'package/LICENSE', data: Buffer.from('MIT License\n') },
  ];
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, Math.min(e.name.length, 100));
    h.write('0000644\0', 100, 8);
    h.write('0000000\0', 108, 8);
    h.write('0000000\0', 116, 8);
    h.write(`${e.data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    h.write(''.padEnd(12, '\0'), 136, 12);
    h.write('0', 156, 1);
    h.write('ustar\0', 257, 6);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(h, e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** fetchers 替身：npm 元数据给 registrySri、下载写 tarball 字节并报 downloadSri（默认两者一致）。 */
function makeFetchers(tarball: Buffer, registrySri: string) {
  const url = `data:application/octet-stream;base64,${tarball.toString('base64')}`;
  return {
    npm: async (input: { pkg: string; version?: string }) => ({
      tarballUrl: url,
      integrity: registrySri,
      version: input.version ?? MANIFEST.version,
    }),
    download: async (input: { url: string; dest: string }) => {
      void input.url;
      const { mkdir: md, writeFile: wf } = await import('node:fs/promises');
      await md(join(input.dest, '..'), { recursive: true });
      await wf(input.dest, tarball);
      return { sri: sriFromBuffer(tarball), size: tarball.length };
    },
    github: async () => {
      throw new Error('本测试不解析 github');
    },
  };
}

/** 空 lock + 单条 entries 帮手。 */
function lockWith(entry?: {
  source: string;
  integrity?: string;
  manifestHash: string;
  version?: string;
}): Parameters<typeof resolveSources>[0]['lock'] {
  return {
    lockVersion: 1,
    generatedAt: '2026-09-18T00:00:00.000Z',
    modules: entry ? { todo: { source: entry.source, integrity: entry.integrity, manifestHash: entry.manifestHash, contractVersion: '1.0', version: entry.version ?? '1.2.0' } } : {},
  };
}

// ---------------------------------------------------------------------------
// ① parseSource loopback http 规则
// ---------------------------------------------------------------------------

describe('parseSource loopback http 规则（issue #269）', () => {
  it('loopback http 放行：url 原样、kind 复用 https（下游零改动）', () => {
    expect(parseSource('http://127.0.0.1:8080/x.tgz')).toEqual({ kind: 'https', url: 'http://127.0.0.1:8080/x.tgz' });
    expect(parseSource('http://localhost:1/x.tgz')).toEqual({ kind: 'https', url: 'http://localhost:1/x.tgz' });
    expect(parseSource('http://[::1]:9/x.tar.gz')).toEqual({ kind: 'https', url: 'http://[::1]:9/x.tar.gz' });
  });

  it('loopback http 同样只认 tarball 后缀', () => {
    expect(() => parseSource('http://localhost:9/index.html')).toThrow(/tarball/);
  });

  it('【红灯】非 loopback 明文 http → 拒绝且文案含 HTTPS（决策 #58 信任边界）', () => {
    expect(() => parseSource('http://evil.example.com/x.tgz')).toThrow(/HTTPS/);
  });

  it('【红灯】改坏 loopback 判定（如放行任意 http）→ 本用例必红', () => {
    // 守住 hostname 白名单：这俩都是公网/局域网名，不在 loopback 词表
    expect(() => parseSource('http://192.168.1.10/x.tgz')).toThrow(/HTTPS/);
    expect(() => parseSource('http://[::2]/x.tgz')).toThrow(/HTTPS/);
  });
});

// ---------------------------------------------------------------------------
// ② file: 目录形态 preview
// ---------------------------------------------------------------------------

describe('previewModuleSource：file: 目录形态', () => {
  it('返回 id / version / permissions / storage（manifest.json + worker.js 形态）', async () => {
    const dir = join(work, 'my-module');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'manifest.json'),
      manifestText({
        description: '目录预览模块',
        storage: { accepts: ['core', 'shared'], preferred: 'shared' },
        permissions: ['storage', 'notify'],
        tables: ['todos'],
      }),
    );
    await writeFile(join(dir, 'worker.js'), 'export default {};\n');
    const preview = await previewModuleSource({ source: `file:${dir}`, cwd: work });
    expect(preview.id).toBe('todo');
    expect(preview.version).toBe('1.2.0');
    expect(preview.permissions).toEqual(['storage', 'notify']);
    expect(preview.storage).toEqual({ accepts: ['core', 'shared'], preferred: 'shared' });
    expect(preview.kind).toBe('file');
    expect(preview.integrity).toBeUndefined(); // 目录形态无下载字节
    expect(preview.manifestText).toContain('"id": "todo"');
    expect(preview.packageDir).toBe(dir);
  });
});

// ---------------------------------------------------------------------------
// ③ 未知能力门禁（预览期 = 安装期同一道门）
// ---------------------------------------------------------------------------

describe('未知能力门禁（issue #269 / 决策 #56）', () => {
  it('【红灯】词表外能力 → 抛错且点名能力名（schema 只报 Invalid option，看不到名字）', async () => {
    const dir = join(work, 'unknown-perm');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), manifestText({ permissions: ['storage', 'telepathy'] }));
    await writeFile(join(dir, 'worker.js'), 'export default {};\n');
    await expect(previewModuleSource({ source: `file:${dir}`, cwd: work })).rejects.toThrow(/telepathy/);
    // 双保险：文案里带词表（用户知道改成什么）
    await previewModuleSource({ source: `file:${dir}`, cwd: work }).catch((err: Error) => {
      expect(err.message).toContain('storage');
      expect(err.message).toContain('拒绝');
    });
  });
});

// ---------------------------------------------------------------------------
// ④⑤ reuse 完整性收紧（resolveSources 路径；暂存包被清 → 重取包也必须过 lock 比对）
// ---------------------------------------------------------------------------

describe('reuse 完整性收紧（issue #269 / 决策 #60 补口子）', () => {
  it('【红灯】lock 记了 integrity，暂存包被清后重取：字节 SRI 与 lock 不符 → 拒绝安装', async () => {
    const good = makePkgTarball();
    const evil = makePkgTarball({ manifest: manifestText({ description: '被换掉的包' }) });
    const root = join(work, 'reuse-integrity');
    // lock：期望 SRI = good 字节；registry 元数据与下载替身一致地报 evil 的 SRI（模拟「源头已换新包」
    // ——registry 一致性检查拦不住，只有 lock 比对能挡：这正是暂存被清后重取的静默换包口子）
    const fetchers = makeFetchers(evil, sriFromBuffer(evil));
    const err = await resolveSources({
      rootDir: root,
      outDir: join(root, '.deploy', 'cloudflare'),
      entries: [{ id: 'todo', source: 'npm:todo@1.2.0' }],
      lock: lockWith({ source: 'npm:todo@1.2.0', integrity: sriFromBuffer(good), manifestHash: manifestHashOf(MANIFEST) }),
      confirmed: true,
      fetchers,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('integrity');
    expect((err as Error).message).toContain('拒绝安装');
    // 红灯验证：若收紧逻辑回退（stageFromTarball 不比对 prev.integrity），resolveSources 会静默成功
    expect((err as Error).message).not.toContain('未实现');
  });

  it('【红灯】integrity 一致但 lock manifestHash 与包内 manifest 不符 → 拒绝安装（文案含 manifestHash）', async () => {
    const root = join(work, 'reuse-hash');
    // 包内 manifest 的 description 与 lock 记账时不同 → manifestHash 必变；integrity 与 lock 一致
    const tampered = makePkgTarball({ manifest: manifestText({ description: '内容变了版本没变' }) });
    const fetchers = makeFetchers(tampered, sriFromBuffer(tampered));
    const err = await resolveSources({
      rootDir: root,
      outDir: join(root, '.deploy', 'cloudflare'),
      entries: [{ id: 'todo', source: 'npm:todo@1.2.0' }],
      lock: lockWith({
        source: 'npm:todo@1.2.0',
        integrity: sriFromBuffer(tampered),
        manifestHash: manifestHashOf(MANIFEST), // 锁的是基线 manifest，包内是 tampered 版
      }),
      confirmed: true,
      fetchers,
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain('manifestHash');
    expect((err as Error).message).toContain('拒绝安装');
  });

  it('changed（显式换源/升级）不受收紧影响：integrity/manifestHash 与 lock 旧值不一致也放行', async () => {
    const v2 = makePkgTarball({ manifest: manifestText({ version: '2.0.0', description: '升级后的包' }) });
    const root = join(work, 'changed-allowed');
    const fetchers = makeFetchers(v2, sriFromBuffer(v2));
    const res = await resolveSources({
      rootDir: root,
      outDir: join(root, '.deploy', 'cloudflare'),
      entries: [{ id: 'todo', source: 'npm:todo@2.0.0' }],
      lock: lockWith({ source: 'npm:todo@1.2.0', integrity: 'sha512-PRESENT', manifestHash: manifestHashOf(MANIFEST) }),
      confirmed: true,
      fetchers,
    });
    expect(res.sourced).toHaveLength(1);
    expect(res.sourced[0]!.version).toBe('2.0.0');
  });

  it('reuse 且暂存包在盘：行为不变（manifestHash 比对通过 → 复用，不重新下载）', async () => {
    const tarball = makePkgTarball();
    const root = join(work, 'reuse-staged');
    const outDir = join(root, '.deploy', 'cloudflare');
    // 先手动布置暂存包（模拟上次安装留下的 .deploy/module-sources/todo/package）
    const staged = join(outDir, 'module-sources', 'todo', 'package');
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, 'manifest.json'), manifestText());
    await writeFile(join(staged, 'worker.js'), 'export default {};\n');
    // lock 与 config 一致、manifestHash 对得上 → 直接复用（fetchers 一调用就该炸）
    const res = await resolveSources({
      rootDir: root,
      outDir,
      entries: [{ id: 'todo', source: 'npm:todo@1.2.0' }],
      lock: lockWith({ source: 'npm:todo@1.2.0', integrity: sriFromBuffer(tarball), manifestHash: manifestHashOf(MANIFEST) }),
      confirmed: true,
      fetchers: {
        npm: async () => {
          throw new Error('不应重新解析 npm 来源');
        },
        download: async () => {
          throw new Error('不应重新下载');
        },
        github: async () => {
          throw new Error('不应解析 github');
        },
      },
    });
    expect(res.sourced).toHaveLength(1);
    expect(res.sourced[0]!.packageDir).toBe(staged);
  });
});
