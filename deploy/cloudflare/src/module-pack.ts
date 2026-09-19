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
 * - `package.json`（**生成**，非收录作者源码目录里那份；issue #285 / 决策 #78：
 *   npm 只认「npm 布局」的 tarball——根目录 `package/package.json` 是 `npm publish` 的硬要求，
 *   字段 name/version/files/license 由打包器从 manifest 派生，`version` 恒与 manifest.json 一致）
 * - `wrangler.jsonc` / `migrations/**` / `assets/**` / `config.schema` / `theme.json` / `docker/**`
 * - `LICENSE` / `NOTICE`（存在即随包；docs/modules.md §2）
 * 排除：`node_modules/`、`.env*`、`test/`、`src/`、`tsconfig.json`、作者源码目录里的 `package.json`、`.git/`（docs/modules.md §2 禁令）。
 *
 * **npm 布局**：tarball 成员一律加 `package/` 前缀（`extractTarball` 全量剥前缀后即包根）。
 */
import { readFile, readdir, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
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
  /** 生成的 `package.json` 的 npm 包名（缺省 = `manifest.id`；issue #285 C2，作者可用 `--name @scope/pkg` 覆盖）。 */
  npmName?: string;
  /**
   * 版本覆盖（`unself module pack --version x.y.z`，tag 即版本）：
   * **同时**写进 packed 的 `manifest.json` 与生成的 `package.json`（issue #285 C8）；缺省沿用 manifest 里的版本。
   */
  version?: string;
}

/** semver（与 manifest.version 同规：严格 x.y.z）。 */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** npm 包名（含可选 scope；小写，不校验 registry 保留名）。 */
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * 生成 `package.json` 的 license 字段。
 * manifest 契约（docs/modules.md §3）没有 license 字段，源目录也可能没有 package.json——
 * 平台默认取自身交付许可（AGPL-3.0-only）。第三方模块如需别的 SPDX，需先有契约字段（docs 偏差已进报告）。
 */
const DEFAULT_PACKAGE_LICENSE = 'AGPL-3.0-only';

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
  // 目录先绝对化（#284 实测）：相对目录会让 ① esbuild 入口解析失败，
  // ② LICENSE 祖先回溯在 `dirname('.') === '.'` 处提前 break → 包内静默缺 LICENSE。
  const dir = resolvePath(input.dir);
  if (!existsSync(dir)) throw new Error(`模块目录不存在：${input.dir}`);

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

  // 版本覆盖（C8）：先落到 manifest，后续 packed manifest.json / package.json / tarball 文件名全部随之
  if (input.version !== undefined) {
    if (!SEMVER_RE.test(input.version)) {
      throw new Error(`--version 非法：${input.version}（须形如 1.2.3，与 manifest.version 同规）`);
    }
    manifest = { ...manifest, version: input.version };
    // manifest.json 已按旧版本写入 files：覆盖后必须重序列化，保证 packed manifest 与 package.json 同版本
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

  // 生成 package.json（C2）：npm 布局下 `npm publish` 的硬要求（缺它报 ENOENT package.json）。
  // name 缺省 = manifest.id，可用 --name 覆盖；version 恒与 manifest.json 一致（C3）；
  // files 列出包根全部文件——从目录 `npm pack`/`npm publish` 时它决定收录面，必须完整。
  const npmName = input.npmName ?? manifest.id;
  if (!NPM_NAME_RE.test(npmName)) {
    throw new Error(`npm 包名非法：${npmName}（须小写，可带 @scope/，如 @acme/unself-todo）`);
  }
  const rootNames = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const packageJson = {
    name: npmName,
    version: manifest.version,
    files: [...rootNames, 'package.json'].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    license: DEFAULT_PACKAGE_LICENSE,
  };
  files.set('package.json', Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`, 'utf8'));

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
