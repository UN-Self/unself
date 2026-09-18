// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块打包器（docs/modules.md §2/§8 承诺的打包器，issue #269）。
 *
 * 输入：模块目录 —— 源码形态（`manifest.yaml` + `src/`，入口由 package.json main 决定）
 * 或已打包形态（包根已有 `manifest.json` + `worker.js`）。
 * 输出：
 * - `modulePackageFiles`：包根文件清单（相对路径 → 字节）；
 * - `packModuleDir`：`.tgz`（成员加 `package/` 前缀 = npm 形态，`extractTarball` 可直接解） + SRI。
 *
 * **builtin 与 pack 同一条路**（#257 验收③）：`packages/installer/scripts/build-artifacts.ts`
 * 用它产出 `<artifacts>/modules/<id>/`，故 pack 出来的包与 builtin 包**字节一致**。
 * worker 打包复用引擎 assemble 的 `moduleWorkerEntry` / `bundleModuleWorker`（不另写一套 esbuild 参数）。
 *
 * 入选文件（包根相对路径）：
 * - `manifest.json`（必需；源码形态由 manifest.yaml 单轨解析后序列化）
 * - `worker.js`（`runtimes ∋ worker`；源码形态走 esbuild bundle，已打包形态原样收录）
 * - `wrangler.jsonc` / `migrations/**` / `assets/**` / `config.schema` / `theme.json` / `docker/**`
 * - `LICENSE` / `NOTICE`（存在即随包；docs/modules.md §2）
 * 排除：`node_modules/`、`.env*`、`test/`、`src/`、`tsconfig.json`、`package.json`、`.git/`（docs/modules.md §2 禁令）。
 */
import { readFile, readdir, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cwd as processCwd } from 'node:process';
import type { ModuleManifest } from '@unself/contracts';
import { ModuleManifestSchema, manifestFromYamlText } from '@unself/contracts';
import { bundleModuleWorker, moduleWorkerEntry } from './assemble';
import { sriFromBuffer } from './sources';
import { writeTarball } from './tar-write';

/** 包根内的一个文件（name 为包根相对路径，posix 分隔）。 */
export interface ModulePackageFile {
  name: string;
  data: Buffer;
}

export interface ModulePackageInput {
  /** 模块目录（绝对或相对；须含 manifest.yaml 或 manifest.json）。 */
  dir: string;
  /** 打包进度人话输出（缺省静默）。 */
  log?: (msg: string) => void;
}

/** 递归收录目录下所有文件（保持包根相对 posix 路径）。 */
async function collectTree(rootDir: string, relBase: string, out: Map<string, Buffer>): Promise<void> {
  const children = await readdir(rootDir, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    const abs = join(rootDir, child.name);
    const rel = `${relBase}/${child.name}`;
    if (child.isDirectory()) await collectTree(abs, rel, out);
    else if (child.isFile()) out.set(rel, await readFile(abs));
  }
}

/** 沿祖先目录向上找第一个含 LICENSE 的目录（最多 maxLevels 层），返回 { LICENSE 字节, NOTICE? 字节 } 或 null。 */
async function findAncestorLicense(
  startDir: string,
  maxLevels: number,
  log?: (msg: string) => void,
): Promise<{ license: Buffer; notice?: Buffer } | null> {
  let dir = startDir;
  for (let i = 0; i < maxLevels; i++) {
    dir = dirname(dir);
    if (dir === dirname(dir)) break; // 文件系统根，再无祖先
    const licensePath = join(dir, 'LICENSE');
    if (existsSync(licensePath)) {
      if (i > 0) {
        log?.(`模块目录无 LICENSE，沿目录向上取 ${licensePath}（许可证随包，docs/modules.md §2）`);
      }
      const noticePath = join(dir, 'NOTICE');
      return { license: await readFile(licensePath), notice: existsSync(noticePath) ? await readFile(noticePath) : undefined };
    }
  }
  log?.('模块目录与祖先目录均无 LICENSE——安装校验 validateModulePackage 会硬拦缺 LICENSE 的包');
  return null;
}

/**
 * 产出包根文件清单（相对包根路径 → 字节）。失败即抛人话错误（缺 manifest / main 指向不存在等）。
 * 同一份输入两次调用必须产出**逐字节相同**的清单（打包确定性）。
 */
export async function modulePackageFiles(
  input: ModulePackageInput,
): Promise<{ manifest: ModuleManifest; files: ModulePackageFile[] }> {
  const dir = input.dir;
  if (!existsSync(dir)) throw new Error(`模块目录不存在：${dir}`);

  // manifest：优先包根 manifest.json（已打包形态），否则 manifest.yaml 单轨解析（@unself/contracts）
  const files = new Map<string, Buffer>();
  let manifest: ModuleManifest;
  const jsonPath = join(dir, 'manifest.json');
  if (existsSync(jsonPath)) {
    const manifestJson = await readFile(jsonPath, 'utf8');
    manifest = ModuleManifestSchema.parse(JSON.parse(manifestJson));
    files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  } else {
    const yamlPath = join(dir, 'manifest.yaml');
    if (!existsSync(yamlPath)) {
      throw new Error(`模块目录缺 manifest：${dir}（需 manifest.json 或 manifest.yaml，docs/modules.md §2）`);
    }
    manifest = ModuleManifestSchema.parse(manifestFromYamlText(await readFile(yamlPath, 'utf8')) as Record<string, unknown>);
    files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  }

  // worker.js：runtimes ∋ worker 才产出；已打包形态原样收录，源码形态复用引擎的 esbuild 打包
  if (manifest.runtimes.includes('worker')) {
    if (existsSync(join(dir, 'worker.js'))) {
      files.set('worker.js', await readFile(join(dir, 'worker.js')));
    } else {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'unself-pack-'));
      try {
        const outfile = join(tmpRoot, 'worker.js');
        await bundleModuleWorker(await moduleWorkerEntry(dir), outfile);
        files.set('worker.js', await readFile(outfile));
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    }
  }

  // 可选单文件与目录（存在即收录；白名单制，docs/modules.md §2 排除项一概不入）
  const optionalFiles = ['wrangler.jsonc', 'config.schema', 'theme.json'];
  for (const name of optionalFiles) {
    const p = join(dir, name);
    if (existsSync(p)) files.set(name, await readFile(p));
  }
  for (const tree of ['migrations', 'assets', 'docker']) {
    const p = join(dir, tree);
    if (existsSync(p) && statSync(p).isDirectory()) await collectTree(p, tree, files);
  }

  // LICENSE / NOTICE：包根没有就沿祖先向上找（builtin 模块自身无 LICENSE，打包需随根 LICENSE 才能过安装校验）
  if (!existsSync(join(dir, 'LICENSE'))) {
    const found = await findAncestorLicense(dir, 8, input.log);
    if (found) {
      files.set('LICENSE', found.license);
      if (found.notice) files.set('NOTICE', found.notice);
    }
  } else {
    files.set('LICENSE', await readFile(join(dir, 'LICENSE')));
    if (existsSync(join(dir, 'NOTICE'))) files.set('NOTICE', await readFile(join(dir, 'NOTICE')));
  }

  // 打包确定性：按包根相对路径排序输出（Map 插入序不参与输出序）
  const sorted = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    manifest,
    files: sorted.map((name) => ({ name, data: files.get(name)! })),
  };
}

/**
 * 打包成 `.tgz`。
 * @param input.outDir 输出目录（缺省 = process.cwd()）；文件名 `<id>-<version>.tgz`。
 * @returns tarball 绝对路径 + 包字节 SRI（sha512-<base64>，与 registry `dist.integrity` 同构）。
 */
export async function packModuleDir(
  input: ModulePackageInput & { outDir?: string },
): Promise<{ tarballPath: string; integrity: string; manifest: ModuleManifest; files: ModulePackageFile[] }> {
  const { manifest, files } = await modulePackageFiles(input);
  const outDir = input.outDir ?? processCwd();
  mkdirSync(outDir, { recursive: true });
  const tarballPath = join(outDir, `${manifest.id}-${manifest.version}.tgz`);
  const tarEntries = files.map((f) => ({ name: `package/${f.name}`, data: f.data }));
  await writeTarball(tarEntries, tarballPath);
  const integrity = sriFromBuffer(await readFile(tarballPath));
  input.log?.(`已打包 ${tarballPath}（${files.length} 个文件，${integrity.slice(0, 27)}…）`);
  return { tarballPath, integrity, manifest, files };
}
