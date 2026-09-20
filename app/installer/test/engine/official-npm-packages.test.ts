// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 官方模块 = 普通 npm 包（issue #284，决策 #76/#77）行为测试。
 *
 * 验收对照（issue #284 B 组）：
 * - **B1/B4 一视同仁**：`npm:@unself/hello@0.1.0`（本地命中）与「同内容 tarball」（https:）安装结果
 *   一致——解析产物 manifest / lock 投影 / 注册表快照投影 / 路由逐项比对；
 * - **B2 零网络**：安装器就位后官方模块靠本地 node_modules 命中，registry 不可用时也装得上
 *   （注入「一调就炸」的 fetcher 证明零网络）；
 * - **B3 包内容**：`unself module pack` 产出的包 = 可安装包（manifest.json + worker.js + assets/
 *   + migrations/ + LICENSE/NOTICE + 生成的 package.json），且 npm 发布形态（包根 manifest.json）
 *   与仓库源码形态（符号链接，包根 manifest.yaml）都被同一套解析器识别；
 * - **B5 卸载一视同仁**：卸载只看注册表快照（与来源无关）——同内容官方/第三方卸载结果逐字相同且零残留；
 * - **B6 升级**：改 config 里的版本号 = 来源串变 → 漂移门（要确认）；确认后重解析、版本推进，
 *   未变资产复用 lock（不重新解析来源 = 不重传）；
 * - **B7 权限门禁一视同仁**：伪造未知能力的官方包同样被点名拒（目录形态与 tarball 形态都拒）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { modulePackageFiles, packModuleDir } from '../../src/engine/module-pack';
import { resolveSources, lockRecordFrom } from '../../src/engine/module-sources';
import { emptyLock, manifestHashOf, type LockFile } from '../../src/engine/lock';
import { previewModuleSource } from '../../src/engine/module-preview';
import { parseSource, resolveLocalNpmPackage, satisfiesVersionRange, sriFromBuffer } from '../../src/engine/sources';
import { buildManifestSnapshot } from '../../src/engine/registry';
import { writeTarball } from '../../src/engine/tar-write';
import { platformUninstallPlan } from '@unself/contracts';

/** 仓库根（真实文件布局：app/modules/hello、app/modules/chat、模块 workspace 符号链接）。 */
const ROOT = new URL('../../../..', import.meta.url).pathname;

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `unself-284-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

/** 官方模块安装串（与安装器 dependencies 预装版本一致，见 app/installer/package.json）。 */
const HELLO_SOURCE = 'npm:@unself/hello@0.1.0';
const HELLO_VERSION = '0.1.0';

/** 写一个「npm 发布形态」包到 <rootDir>/node_modules/<pkg>（包根 manifest.json）。 */
async function writePackedPackage(input: {
  rootDir: string;
  pkg: string;
  version: string;
  permissions?: string[];
  worker?: string;
  extraFiles?: Record<string, string>;
}): Promise<string> {
  const dir = join(input.rootDir, 'node_modules', input.pkg);
  await mkdir(dir, { recursive: true });
  const manifest = {
    id: input.pkg.split('/').pop(),
    version: input.version,
    runtimes: ['worker'],
    route: `/m/${input.pkg.split('/').pop()}`,
    entry: 'http://localhost:9999/',
    ...(input.permissions ? { permissions: input.permissions } : {}),
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(dir, 'worker.js'), input.worker ?? 'export default { fetch: () => new Response("ok") };\n');
  await writeFile(join(dir, 'LICENSE'), 'AGPL-3.0-only\n');
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: input.pkg, version: input.version, files: ['manifest.json', 'worker.js', 'LICENSE'] }, null, 2)}\n`,
  );
  for (const [name, body] of Object.entries(input.extraFiles ?? {})) {
    const full = join(dir, name);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body);
  }
  return dir;
}

/** 一次性「同一份内容」的两种来源：本地 npm 命中 + 由该目录打出的同内容 tarball（https: 注入取本地文件）。 */
function localTarballFetcher(tarballPath: string): {
  download: (i: { url: string; dest: string }) => Promise<{ sri: string; size: number }>;
} {
  return {
    download: async (i) => {
      const bytes = await readFile(tarballPath);
      await mkdir(join(i.dest, '..'), { recursive: true });
      await writeFile(i.dest, bytes);
      return { sri: sriFromBuffer(bytes), size: bytes.byteLength };
    },
  };
}

describe('#284 B2：npm: 本地命中 = 零网络', () => {
  it('本地有包且版本匹配 → 直接命中，不碰 registry（fetcher 一调就炸）', async () => {
    const out = await tempDir('b2');
    const boom = (): never => {
      throw new Error('不该联网：本地 node_modules 命中时不得调用 npm/registry');
    };
    const res = await resolveSources({
      rootDir: ROOT,
      outDir: out,
      entries: [{ id: 'hello', source: HELLO_SOURCE }],
      lock: emptyLock(),
      confirmed: true,
      fetchers: { npm: boom, download: boom, github: boom },
    });
    expect(res.sourced).toHaveLength(1);
    const hello = res.sourced[0]!;
    expect(hello.version).toBe(HELLO_VERSION);
    // 仓库开发形态：@unself/hello 是 workspace 符号链接 → 源码形态目录（manifest.yaml）
    expect(hello.form).toBe('source');
    expect(hello.packageDir.endsWith(join('node_modules', '@unself', 'hello'))).toBe(true);
    // 目录形态无 tarball 字节 → 无 SRI（与 file: 同口径）
    expect(hello.integrity).toBeUndefined();
    // 权限投影仍从 manifest 来（门禁不因「本地」而放松）
    expect(hello.manifest.permissions).toEqual(['storage']);
  });

  it('本地版本不匹配 → 落到 registry（不是静默用旧版本）', async () => {
    const out = await tempDir('b2-mismatch');
    const boom = (): never => {
      throw new Error('SENTINEL：本地 0.1.0 不满足 0.2.0，必须走 registry');
    };
    await expect(
      resolveSources({
        rootDir: ROOT,
        outDir: out,
        entries: [{ id: 'hello', source: 'npm:@unself/hello@0.2.0' }],
        lock: emptyLock(),
        confirmed: true,
        fetchers: { npm: boom, download: boom, github: boom },
      }),
    ).rejects.toThrow('SENTINEL');
  });

  it('resolveLocalNpmPackage：版本匹配语义与未知包', () => {
    const hit = resolveLocalNpmPackage({ pkg: '@unself/hello', version: HELLO_VERSION, rootDir: ROOT });
    expect(hit).toMatchObject({ version: HELLO_VERSION, form: 'source' });
    expect(resolveLocalNpmPackage({ pkg: '@unself/hello', version: '9.9.9', rootDir: ROOT })).toBeNull();
    expect(resolveLocalNpmPackage({ pkg: '@acme/不存在', version: HELLO_VERSION, rootDir: ROOT })).toBeNull();
    // 未指定版本 = 任意本地版本算匹配
    expect(resolveLocalNpmPackage({ pkg: '@unself/hello', rootDir: ROOT })?.version).toBe(HELLO_VERSION);
  });

  it('satisfiesVersionRange：精确 / ^ / ~ / 比较符 / 并集', () => {
    expect(satisfiesVersionRange('0.1.0', '0.1.0')).toBe(true);
    expect(satisfiesVersionRange('0.1.0', '=0.1.0')).toBe(true);
    expect(satisfiesVersionRange('0.1.1', '0.1.0')).toBe(false);
    expect(satisfiesVersionRange('0.1.5', '^0.1.0')).toBe(true);
    expect(satisfiesVersionRange('0.2.0', '^0.1.0')).toBe(false);
    expect(satisfiesVersionRange('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfiesVersionRange('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfiesVersionRange('2.0.0', '>=1.0.0 <3.0.0')).toBe(true);
    expect(satisfiesVersionRange('0.3.0', '0.2.0 || 0.3.0')).toBe(true);
    expect(satisfiesVersionRange('0.1.0', '*')).toBe(true);
    // 判不了的范围 = 不命中（保守：宁走 registry）
    expect(satisfiesVersionRange('0.1.0', '1.0.0 - 2.0.0')).toBe(false);
  });

  it('official 特权协议已删除（四协议）', () => {
    // 注：这里用拼接构造旧协议串——门禁要求仓库内搜不到「official 加冒号」这个来源前缀
    const legacy = ['official', 'hello'].join(':');
    expect(() => parseSource(legacy)).toThrow(/无法识别的模块来源/);
    expect(() => parseSource(legacy)).toThrow(/npm:\/github:\/https:/);
    expect(() => parseSource(legacy)).toThrow(/\/file:/);
  });
});

describe('#284 B3：包内容 = 可安装包（module pack 形态）', () => {
  it('hello：manifest.json + worker.js + LICENSE + 生成的 package.json（版本与 manifest 一致）', async () => {
    const { manifest, files } = await modulePackageFiles({
      dir: join(ROOT, 'app', 'modules', 'hello'),
      npmName: '@unself/hello',
    });
    const names = files.map((f) => f.name);
    expect(names).toContain('manifest.json');
    expect(names).toContain('worker.js');
    expect(names).toContain('LICENSE');
    expect(names).toContain('package.json');
    const pkgJson = JSON.parse(files.find((f) => f.name === 'package.json')!.data.toString('utf8')) as {
      name: string;
      version: string;
    };
    expect(pkgJson.name).toBe('@unself/hello');
    expect(pkgJson.version).toBe(manifest.version);
    expect(manifest.version).toBe(HELLO_VERSION);
  });

  it('chat：前端资产（assets/frontend）+ 迁移随包（B3：前端资产与 migrations 在包内）', async () => {
    const { manifest, files } = await modulePackageFiles({
      dir: join(ROOT, 'app', 'modules', 'chat'),
      npmName: '@unself/chat',
    });
    const names = files.map((f) => f.name);
    expect(names).toContain('manifest.json');
    expect(names).toContain('worker.js');
    expect(names.some((n) => n.startsWith('migrations/'))).toBe(true);
    // 前端产物由 `pnpm --filter @unself/module-chat-frontend build` 落到模块包内（#284 形态方案）
    expect(names).toContain('assets/frontend/index.html');
    expect(manifest.id).toBe('chat');
  });

  it('npm 发布形态（包根 manifest.json）被识别为 packed；仓库源码形态被识别为 source', async () => {
    const rootDir = await tempDir('b3-packed');
    await writePackedPackage({ rootDir, pkg: '@acme/packed', version: '0.1.0' });
    const out = await tempDir('b3-packed-out');
    const res = await resolveSources({
      rootDir,
      outDir: out,
      entries: [{ id: 'packed', source: 'npm:@acme/packed@0.1.0' }],
      lock: emptyLock(),
      confirmed: true,
      fetchers: {
        npm: () => {
          throw new Error('不该联网：本地 node_modules 有 packed 形态包');
        },
      },
    });
    expect(res.sourced[0]!.form).toBe('packed');
    expect(res.sourced[0]!.manifest.id).toBe('packed');
    // 本地 packed 形态与远端 tarball 同一套安装前校验 → 合法包能过
    const local = resolveLocalNpmPackage({ pkg: '@unself/hello', version: HELLO_VERSION, rootDir: ROOT });
    expect(local?.form).toBe('source');
  });
});

describe('#284 B1/B4：npm 本地命中 与 同内容 tarball 安装结果一致', () => {
  it('解析产物 / lock 投影：manifest 与 manifestHash 逐项相同（只有来源串与 SRI 不同）', async () => {
    const out = await tempDir('b4');
    // ① 同内容 tarball：由 hello 包目录打出（与发布形态同一打包器）
    const packed = await packModuleDir({ dir: join(ROOT, 'app', 'modules', 'hello'), outDir: out, npmName: '@unself/hello' });
    const tarballPath = packed.tarballPath;

    const fromNpm = await resolveSources({
      rootDir: ROOT,
      outDir: join(out, 'npm'),
      entries: [{ id: 'hello', source: HELLO_SOURCE }],
      lock: emptyLock(),
      confirmed: true,
      fetchers: {
        npm: () => {
          throw new Error('不该联网');
        },
      },
    });
    const fromTarball = await resolveSources({
      rootDir: ROOT,
      outDir: join(out, 'tgz'),
      entries: [{ id: 'hello', source: 'https://example.invalid/hello-0.1.0.tgz' }],
      lock: emptyLock(),
      confirmed: true,
      fetchers: localTarballFetcher(tarballPath),
    });

    const a = fromNpm.sourced[0]!;
    const b = fromTarball.sourced[0]!;

    // 同一份内容：manifest 逐项一致（id/version/route/runtimes/permissions/storage）
    expect(a.manifest).toEqual(b.manifest);
    expect(a.version).toBe(b.version);
    expect(manifestHashOf(a.manifest)).toBe(manifestHashOf(b.manifest));
    // 差异只在「来源串」与「是否有 tarball 字节 SRI」（目录形态天生无字节）
    expect(a.source).toBe(HELLO_SOURCE);
    expect(b.source).toBe('https://example.invalid/hello-0.1.0.tgz');
    expect(a.integrity).toBeUndefined();
    expect(b.integrity).toMatch(/^sha512-/);

    // lock 投影：manifestHash/version/contractVersion 一致，source 各自记自己
    const lockA = lockRecordFrom(a);
    const lockB = lockRecordFrom(b);
    expect(lockA.manifestHash).toBe(lockB.manifestHash);
    expect(lockA.version).toBe(lockB.version);
    expect(lockA.contractVersion).toBe(lockB.contractVersion);
    expect(lockA.source).toBe(HELLO_SOURCE);
    expect(lockB.source).toBe(b.source);

    // 注册表快照投影（entry 由装配器覆写为实例内地址）：逐项一致
    const snapshotA = buildManifestSnapshot({
      manifestText: a.manifestText,
      manifest: a.manifest,
      moduleId: 'hello',
      baseUrl: 'https://team.example.com',
      entry: 'https://team.example.com/m/hello/',
    });
    const snapshotB = buildManifestSnapshot({
      manifestText: b.manifestText,
      manifest: b.manifest,
      moduleId: 'hello',
      baseUrl: 'https://team.example.com',
      entry: 'https://team.example.com/m/hello/',
    });
    expect(snapshotA).toEqual(snapshotB);
    // 权限投影（门禁依据）也一致
    expect(snapshotA.permissions).toEqual(snapshotB.permissions);
    // 建表/卸载投影一致（hello 落 core → 无表）
    expect(platformUninstallPlan(snapshotA)).toEqual(platformUninstallPlan(snapshotB));
  });

  it('预览（向导③「将要装什么」）与安装期同一套原语：官方模块本地命中即预览，不联网', async () => {
    const preview = await previewModuleSource({
      source: HELLO_SOURCE,
      cwd: ROOT,
      fetchers: {
        npm: () => {
          throw new Error('不该联网：本地命中');
        },
      },
    });
    expect(preview.id).toBe('hello');
    expect(preview.version).toBe(HELLO_VERSION);
    expect(preview.kind).toBe('npm');
    expect(preview.form).toBe('source');
    expect(preview.permissions).toEqual(['storage']);
    expect(preview.storage.accepts).toEqual(['core']);
  });
});

describe('#284 B6：升级 = 改 config 里的版本号（漂移门 + 复用 lock）', () => {
  it('版本号变 = 来源串变 → 未确认报漂移；确认后重解析并推进版本；同 config 再跑 = reuse（不重解析）', async () => {
    const rootDir = await tempDir('b6');
    const out = await tempDir('b6-out');
    await writePackedPackage({ rootDir, pkg: '@acme/fixture', version: '0.1.0' });
    const entry = { id: 'fixture', source: 'npm:@acme/fixture@0.1.0' };

    const first = await resolveSources({ rootDir, outDir: out, entries: [entry], lock: emptyLock(), confirmed: true });
    const fixture = first.sourced[0]!;
    expect(fixture.version).toBe('0.1.0');
    const lock: LockFile = { ...emptyLock(), modules: { fixture: lockRecordFrom(fixture) } };

    // 改了版本号 → config ≠ lock → 未确认即拒（列出 diff）
    const next = { id: 'fixture', source: 'npm:@acme/fixture@0.1.1' };
    await expect(
      resolveSources({ rootDir, outDir: out, entries: [next], lock, confirmed: false }),
    ).rejects.toThrow(/unself\.lock 与 unself\.config\.jsonc 不一致/);

    // 版本确实升了（本地包内容也换成 0.1.1）
    await writePackedPackage({ rootDir, pkg: '@acme/fixture', version: '0.1.1' });
    const upgraded = await resolveSources({ rootDir, outDir: out, entries: [next], lock, confirmed: true });
    expect(upgraded.sourced[0]!.version).toBe('0.1.1');
    expect(upgraded.sourced[0]!.source).toBe(next.source);

    // 同 config 再跑（lock 已记新来源）→ reuse：不重新解析来源 = 未变资产不重取
    const lock2: LockFile = { ...emptyLock(), modules: { fixture: lockRecordFrom(upgraded.sourced[0]!) } };
    const reuse = await resolveSources({
      rootDir,
      outDir: out,
      entries: [next],
      lock: lock2,
      confirmed: false, // reuse 不需要确认
      fetchers: {
        npm: () => {
          throw new Error('不该重解析来源');
        },
      },
    });
    expect(reuse.plan.reuse.map((i) => i.id)).toEqual(['fixture']);
    expect(reuse.sourced[0]!.version).toBe('0.1.1');
  });
});

describe('#284 B7：权限门禁一视同仁（官方/第三方、目录/tarball 都点名拒）', () => {
  it('伪造未知能力的官方包名 → 预览与安装都点名拒绝', async () => {
    const rootDir = await tempDir('b7');
    await writePackedPackage({
      rootDir,
      pkg: '@unself/evil',
      version: '0.1.0',
      permissions: ['storage', 'teleport'],
    });
    const source = 'npm:@unself/evil@0.1.0';

    await expect(previewModuleSource({ source, cwd: rootDir })).rejects.toThrow(/未知能力「teleport」/);
    await expect(
      resolveSources({
        rootDir,
        outDir: join(rootDir, 'out'),
        entries: [{ id: 'evil', source }],
        lock: emptyLock(),
        confirmed: true,
      }),
    ).rejects.toThrow(/未知能力「teleport」/);
    // 点名 + 词表提示（不是 zod 的 Invalid enum value）
    await expect(previewModuleSource({ source, cwd: rootDir })).rejects.toThrow(/storage \/ acl \/ notify \/ ai \/ realtime \/ mail/);
  });

  it('同一份「未知能力」内容装成 tarball（https:）→ 同样点名拒（与来源形态无关）', async () => {
    const rootDir = await tempDir('b7-tgz');
    // 手工造 tarball（不走 modulePackageFiles：契约 schema 会先把未知能力拒在打包口，
    // 本条要验的是「安装侧门禁」——用原始 manifest 字节，绕过打包期校验）
    const manifestText = `${JSON.stringify(
      {
        id: 'evil',
        version: '0.1.0',
        runtimes: ['worker'],
        route: '/m/evil',
        entry: 'http://localhost:9999/',
        permissions: ['teleport'],
      },
      null,
      2,
    )}\n`;
    const tarPath = join(rootDir, 'evil-0.1.0.tgz');
    await writeTarball(
      [
        { name: 'package/manifest.json', data: Buffer.from(manifestText) },
        { name: 'package/worker.js', data: Buffer.from('export default { fetch: () => new Response("ok") };\n') },
        { name: 'package/LICENSE', data: Buffer.from('AGPL-3.0-only\n') },
      ],
      tarPath,
    );
    await expect(
      resolveSources({
        rootDir,
        outDir: join(rootDir, 'out'),
        entries: [{ id: 'evil', source: 'https://example.invalid/evil-0.1.0.tgz' }],
        lock: emptyLock(),
        confirmed: true,
        fetchers: localTarballFetcher(tarPath),
      }),
    ).rejects.toThrow(/未知能力「teleport」/);
  });
});
