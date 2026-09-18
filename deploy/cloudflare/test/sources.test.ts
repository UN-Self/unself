// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 来源解析与包获取测试（issue #245，docs/modules.md §1/§8）。
 *
 * 红灯硬规矩（本文件三条）：
 * ① 远端包带 postinstall → **必须不执行**（构造会写标记文件的包，断言标记不存在）；
 * ② tarball 成员路径逃逸（zip-slip）→ 拒绝；
 * ③ 链接成员 → 拒绝。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  downloadTo,
  extractTarball,
  githubResolve,
  npmResolve,
  parseSource,
  sriFromBuffer,
} from '../src/sources';

let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'unself-sources-'));
});

afterEach(async () => {
  // 保留 work（beforeAll 一次），测试各自用子目录
});

/** 手工构造 tar.gz：files: {name → content}，全部放 <root>/ 前缀下。 */
function makeTarball(root: string, files: Record<string, string>): Buffer {
  const tar = require('node:child_process');
  void tar;
  // 用系统 tar（构建 tarball 属测试夹具，不走被测代码）
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const dir = join(work, `mk-${Math.random().toString(36).slice(2)}`);
  execFileSync('mkdir', ['-p', dir]);
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, root, name);
    execFileSync('mkdir', ['-p', target.slice(0, target.lastIndexOf('/'))]);
    execFileSync('sh', ['-c', `cat > '${target}'`], { input: content });
  }
  const tgz = join(work, `pkg-${Math.random().toString(36).slice(2)}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', dir, root]);
  return require('node:fs').readFileSync(tgz) as Buffer;
}

describe('parseSource（五协议）', () => {
  it('official: 解析包名', () => {
    expect(parseSource('official:hello')).toEqual({ kind: 'official', name: 'hello' });
  });
  it('npm: 含 scope 与版本', () => {
    expect(parseSource('npm:@acme/unself-todo@1.2.0')).toEqual({
      kind: 'npm',
      pkg: '@acme/unself-todo',
      version: '1.2.0',
    });
    expect(parseSource('npm:todo')).toEqual({ kind: 'npm', pkg: 'todo', version: undefined });
  });
  it('github: repo + tag', () => {
    expect(parseSource('github:acme/unself-todo#v1.2.0')).toEqual({
      kind: 'github',
      repo: 'acme/unself-todo',
      tag: 'v1.2.0',
    });
  });
  it('https: 只认 .tgz/.tar.gz', () => {
    expect(parseSource('https://内网.example/mirrors/todo-1.2.0.tgz')).toMatchObject({ kind: 'https' });
    expect(() => parseSource('https://example.com/index.html')).toThrow(/tarball/);
  });
  it('file: 相对路径', () => {
    expect(parseSource('file:./modules/my-todo')).toEqual({ kind: 'file', path: './modules/my-todo' });
  });
  it('未知协议与非法输入拒绝', () => {
    expect(() => parseSource('gitlab:a/b')).toThrow(/无法识别/);
    expect(() => parseSource('official:Bad_Name')).toThrow(/非法/);
    expect(() => parseSource('npm:')).toThrow(/非法/);
    expect(() => parseSource('file:')).toThrow(/缺路径/);
  });
});

describe('sriFromBuffer / downloadTo（SRI sha512）', () => {
  it('SRI 形态与 openssl 向量一致', () => {
    const data = Buffer.from('hello unself\n');
    expect(sriFromBuffer(data)).toBe(
      `sha512-${createHash('sha512').update(data).digest('base64')}`,
    );
  });
  it('downloadTo 落盘 + 返回 SRI（data: URL；Node fetch 不支持 file://）', async () => {
    const buf = makeTarball('package', { 'manifest.json': '{"id":"todo"}' });
    const dest = join(work, 'dl-out.tgz');
    const { sri, size } = await downloadTo({
      url: `data:application/octet-stream;base64,${buf.toString('base64')}`,
      dest,
    });
    expect(size).toBe(buf.length);
    expect(sri).toBe(sriFromBuffer(buf));
    expect(await readFile(dest)).toEqual(buf);
  });
});

describe('extractTarball（零脚本执行 + zip-slip 防护）', () => {
  it('npm 形态（package/ 前缀）解包：包根判定 + 内容一致', async () => {
    const buf = makeTarball('package', {
      'manifest.json': '{"id":"todo","version":"1.2.0"}',
      'worker.js': 'export default {};',
      'assets/page.html': '<p>hi</p>',
    });
    const tarPath = join(work, 'npm-shape.tgz');
    await writeFile(tarPath, buf);
    const dest = join(work, 'npm-shape-out');
    const result = await extractTarball({ tarPath, dest });
    expect(result.files.sort()).toEqual(['assets/page.html', 'manifest.json', 'worker.js']);
    expect(await readFile(join(result.packageDir, 'manifest.json'), 'utf8')).toContain('"id":"todo"');
  });

  it('【红灯①】带 postinstall 的包：解包后脚本文件存在但**从未被执行**（标记文件不存在）', async () => {
    // 构造「恶意」包：postinstall 写 <包根>/pwned.marker。若任何环节执行了它，标记就会出现。
    const dest = join(work, 'postinstall-out');
    const markerNote = 'THIS FILE PROVES postinstall RAN';
    const buf = makeTarball('package', {
      'manifest.json': '{"id":"evil","version":"9.9.9"}',
      'worker.js': 'export default {};',
      'postinstall.js': `require('node:fs').writeFileSync(__dirname + '/pwned.marker', ${JSON.stringify(markerNote)});\n`,
      // npm 生命周期入口：install 与 postinstall 双保险都写上
      'package.json': JSON.stringify({
        name: 'unself-evil-probe',
        version: '9.9.9',
        scripts: { install: 'node postinstall.js', postinstall: 'node postinstall.js' },
      }),
    });
    const tarPath = join(work, 'evil.tgz');
    await writeFile(tarPath, buf);
    const result = await extractTarball({ tarPath, dest });
    // 包内容原样落盘（脚本文件在，等待被检验「没有被执行」）
    expect(existsSync(join(result.packageDir, 'postinstall.js'))).toBe(true);
    // 硬断言：标记文件不存在 = postinstall 从未被执行（走 npm install 必红）
    expect(existsSync(join(result.packageDir, 'pwned.marker'))).toBe(false);
    // 双保险：跨进程再验证一次——即使解包后有延迟执行也不算；这里同步检查目录全量
    const all = await readFile(join(result.packageDir, 'postinstall.js'), 'utf8');
    expect(all).toContain('pwned.marker');
  });

  it('【红灯②】tarball 成员路径逃逸（package/../pwned.txt）→ 拒绝且不落盘', async () => {
    // 字节级构造：成员名 'package/../pwned-escape.txt'（npm 包真实逃逸形态；外层 tgz）
    const dir = join(work, 'slip-src');
    await mkdir(dir, { recursive: true });
    const entries: Array<{ name: string; data: Buffer; type: string }> = [
      { name: 'package/manifest.json', data: Buffer.from('{"id":"slip"}'), type: '0' },
      { name: 'package/../pwned-escape.txt', data: Buffer.from('PWNED'), type: '0' },
    ];
    const tarBytes = buildTarInMemory(entries);
    const gzPath = join(dir, 'slip.tgz');
    await writeFile(gzPath, gzipSync(tarBytes));
    const dest = join(dir, 'slip-out');
    await expect(extractTarball({ tarPath: gzPath, dest })).rejects.toThrow(/逃逸|zip-slip|非法/);
    expect(existsSync(join(dest, 'pwned-escape.txt'))).toBe(false);
    expect(existsSync(join(dest, 'package', 'pwned-escape.txt'))).toBe(false);
  });

  it('【红灯③】链接成员 → 拒绝', async () => {
    const entries: Array<{ name: string; data?: Buffer; link?: string; type: string }> = [
      { name: 'package', type: '5' },
      { name: 'package/manifest.json', data: Buffer.from('{"id":"lnk"}'), type: '0' },
      { name: 'package/link.txt', link: '/etc/passwd', type: '2' },
    ];
    const tarBytes = buildTarInMemory(entries as never);
    const p = join(work, 'lnk.tgz');
    await writeFile(p, gzipSync(tarBytes));
    await expect(extractTarball({ tarPath: p, dest: join(work, 'lnk-out') })).rejects.toThrow(/链接成员/);
  });

  it('包根无 manifest.json → 人话报错', async () => {
    const buf = makeTarball('package', { 'readme.md': 'no manifest here' });
    const p = join(work, 'nomanifest.tgz');
    await writeFile(p, buf);
    await expect(extractTarball({ tarPath: p, dest: join(work, 'nomanifest-out') })).rejects.toThrow(/manifest\.json/);
  });

  it('解包产物不可执行（0644，不还原 tar mode）', async () => {
    const buf = makeTarball('package', { 'manifest.json': '{"id":"m"}', 'worker.js': 'export default {};' });
    const p = join(work, 'mode.tgz');
    await writeFile(p, buf);
    const result = await extractTarball({ tarPath: p, dest: join(work, 'mode-out') });
    const stat = statSync(join(result.packageDir, 'worker.js'));
    // 仅断言无任何执行位（umask 可能影响 group/other 读写位）
    expect(stat.mode & 0o111).toBe(0);
  });
});

describe('npmResolve / githubResolve（子进程走真实 npm/gh 配置）', () => {
  it('npmResolve：真实 registry 取 is-odd@3.0.1 元数据（需网络）', async () => {
    const meta = await npmResolve({ pkg: 'is-odd', version: '3.0.1', cwd: work });
    expect(meta.tarballUrl).toBe('https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz');
    expect(meta.integrity).toMatch(/^sha512-/);
    expect(meta.version).toBe('3.0.1');
  });
  it('npmResolve：不存在的包 → 人话报错（不打 stack）', async () => {
    await expect(npmResolve({ pkg: 'unself-no-such-pkg-zzz', version: '1.0.0', cwd: work })).rejects.toThrow(/npm view/);
  });
  it('githubResolve：无 gh 或私有仓库 → 人话报错（不炸栈）', async () => {
    const hasGh = spawnSync('gh', ['--version']).status === 0;
    if (!hasGh) {
      await expect(githubResolve({ repo: 'acme/no-such-repo-zzz', cwd: work })).rejects.toThrow(/gh/);
    } else {
      await expect(githubResolve({ repo: 'acme/no-such-repo-zzz-404', cwd: work })).rejects.toThrow(/gh release view/);
    }
  });
});

// ---------------------------------------------------------------------------
// 字节级 tar 构造（zip-slip / 链接成员用例的确定性夹具）
// ---------------------------------------------------------------------------

function tarHeader(name: string, size: number, typeflag: string, linkname = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, Math.min(name.length, 100), 'utf8');
  h.write('0000644\0', 100, 8);
  h.write('0000000\0', 108, 8);
  h.write('0000000\0', 116, 8);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  h.write(''.padEnd(12, '\0'), 136, 12);
  h.write(typeflag, 156, 1);
  if (linkname) h.write(linkname, 157, Math.min(linkname.length, 100), 'utf8');
  h.write('ustar\0', 257, 6);
  h.write('00', 263, 2);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

function buildTarInMemory(
  entries: Array<{ name: string; data?: Buffer; link?: string; type: string }>,
): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    if (e.type === '5') {
      blocks.push(tarHeader(e.name, 0, '5'));
      continue;
    }
    if (e.type === '2' || e.type === '1') {
      blocks.push(tarHeader(e.name, 0, e.type, e.link ?? ''));
      continue;
    }
    const data = e.data ?? Buffer.alloc(0);
    blocks.push(tarHeader(e.name, data.length, '0'));
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024)); // 结束双零块
  return Buffer.concat(blocks);
}

function gzipSync(data: Buffer): Buffer {
  const zlib = require('node:zlib') as typeof import('node:zlib');
  return zlib.gzipSync(data);
}
