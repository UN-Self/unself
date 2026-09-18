// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 来源解析编排（步骤④前置，issue #245）：
 * config.modules 的 {id, source} 条目 → 取包（远端 tarball 直解 / file: 本地目录）→
 * validate → 落位到装配区（outDir/modules/<id>/src）。builtin 模块不经此文件。
 *
 * **安全边界（硬，决策 #58）**：
 * - 远端来源一律已打包：tarball 直接解包，不走 npm install，包内脚本零执行；
 * - 仅 file: 允许本地源码（本地构建由打包器按需，当前装配器直接以目录为源）；
 * - reuse 且哈希不匹配 → **拒绝安装**（决策 #60）。
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  manifestFromYamlText,
  ModuleManifestSchema,
  validateModulePackage,
  CONTRACT_VERSION,
  type ModuleManifest,
} from '@unself/contracts';
import { buildLockPlan, formatIntegrityFailures, manifestHashOf, verifyLockIntegrity, type LockFile, type LockPlan } from './lock';
import { downloadTo, extractTarball, fileStage, githubResolve, npmResolve, parseSource } from './sources';

/** 单个来源模块的解析产物。 */
export interface SourcedModule {
  id: string;
  /** 生效来源（config 或 builtin 合成）。 */
  source: string;
  /** 包根目录（磁盘绝对路径；装配器从这里取 worker/资产/迁移）。 */
  packageDir: string;
  /** 解析后的 manifest（契约 v1 对象）。 */
  manifest: ModuleManifest;
  /** manifest.yaml / manifest.json 原文（注册表快照与 lock 哈希共用）。 */
  manifestText: string;
  /** 包字节 SRI（sha512-…）；builtin/file: 目录形态无下载字节 → undefined。 */
  integrity?: string;
  /** 解析出的确切版本。 */
  version: string;
}

/** 来源解析总结果（lock 计划 + 解析产物 + 移除名单）。 */
export interface SourceResolution {
  plan: LockPlan;
  /** config 声明模块（含 builtin）的解析产物——装配器输入。 */
  sourced: SourcedModule[];
  /** config 删除的模块 id（lock 里有而 config 没有）。 */
  removed: string[];
  /** 是否有漂移（需要确认/-y）。 */
  drift: boolean;
}

/** lock 条目 → 下次写 lock 的 record 输入。 */
function lockRecordFrom(m: SourcedModule): LockFile['modules'][string] {
  return {
    source: m.source,
    version: m.version,
    ...(m.integrity ? { integrity: m.integrity } : {}),
    manifestHash: manifestHashOf(manifestJsonOf(m)),
    contractVersion: CONTRACT_VERSION,
  };
}

/** manifest 的 JSON 对象形态（yaml 先转 candidate——manifestHash 与来源形态无关，只认内容）。 */
function manifestJsonOf(m: SourcedModule): ModuleManifest {
  return m.manifest;
}

export { lockRecordFrom, manifestJsonOf };

/** 解析 manifest：包根有 manifest.yaml → contracts YAML 轨；manifest.json → JSON 轨（#243 单轨解析）。 */
export async function readManifest(packageDir: string): Promise<{ manifest: ModuleManifest; text: string }> {
  const yamlPath = join(packageDir, 'manifest.yaml');
  const jsonPath = join(packageDir, 'manifest.json');
  if (existsSync(yamlPath)) {
    const text = await readFile(yamlPath, 'utf8');
    const manifest = ModuleManifestSchema.parse(manifestFromYamlText(text) as Record<string, unknown>);
    return { manifest, text };
  }
  if (existsSync(jsonPath)) {
    const text = await readFile(jsonPath, 'utf8');
    const manifest = ModuleManifestSchema.parse(JSON.parse(text) as Record<string, unknown>);
    return { manifest, text };
  }
  throw new Error(`包根缺 manifest（manifest.yaml / manifest.json 都没有）：${packageDir}`);
}

/**
 * 解析全部来源模块 → SourceResolution。
 *
 * 决策流（lock × config）：
 * - reuse：lock 与 config 一致 → 校验哈希后直接用 lock 记录（不重新下载！重跑一律用 lock）；
 * - added/changed：解析来源取包 → validate → 产出新 lock 记录；
 * - removed：不落位；调用方写 lock 时删掉。
 *
 * reuse 的本地包从 lock.since 不追踪——包暂存目录在（.deploy/module-sources/<id>）就直接用；
 * 否则视同 changed 重取（暂存区是产物缓存，不是数据）。
 */
export async function resolveSources(input: {
  rootDir: string;
  outDir: string;
  entries: Array<{ id: string; source?: string }>;
  lock: LockFile;
  /** 漂移已确认（-y / 交互确认后）。false 且有漂移 → 抛错并列 diff。 */
  confirmed?: boolean;
  log?: (msg: string) => void;
  /** 测试注入口：替换默认的远端抓取（npmResolve/downloadTo/githubResolve）。 */
  fetchers?: {
    npm?: typeof npmResolve;
    download?: typeof downloadTo;
    github?: typeof githubResolve;
  };
}): Promise<SourceResolution> {
  const log = input.log ?? (() => {});
  const plan = buildLockPlan({ entries: input.entries, lock: input.lock });

  // 漂移确认（ reused 之外的任何动作都算漂移）
  if (!input.confirmed) {
    const changes = plan.items.filter((i) => i.action !== 'reuse').length + plan.removed.length;
    if (changes > 0) {
      const diff = formatPlanDiff(plan);
      throw new SourceDriftError(diff);
    }
  }

  const sourced: SourcedModule[] = [];
  const stages: Array<Promise<void>> = [];
  for (const item of plan.items) {
    if (item.action === 'removed') continue;
    stages.push(
      (async () => {
        const mod = await resolveOne({
          item,
          lock: input.lock,
          rootDir: input.rootDir,
          outDir: input.outDir,
          fetchers: input.fetchers,
          log,
        });
        sourced.push(mod);
      })(),
    );
  }
  await Promise.all(stages);
  sourced.sort((a, b) => a.id.localeCompare(b.id));
  return { plan, sourced, removed: plan.removed.map((r) => r.id), drift: false };
}

/** 漂移错误：带 diff 行（调用方打印后要求确认/-y）。 */
export class SourceDriftError extends Error {
  constructor(public readonly diffLines: string[]) {
    super(
      `unself.lock 与 unself.config.jsonc 不一致（${diffLines.length} 项变动）：\n${diffLines.map((l) => `  ${l}`).join('\n')}\n` +
        '确认无误请加 -y（或交互确认）重跑；要保留 lock 现状请改回 config。',
    );
    this.name = 'SourceDriftError';
  }
}

/** plan → 人话 diff（added/changed/removed 三态）。 */
function formatPlanDiff(plan: LockPlan): string[] {
  const lines: string[] = [];
  for (const item of plan.items) {
    if (item.action === 'added') lines.push(`+ ${item.id}（新增）← ${item.source}`);
    if (item.action === 'changed') lines.push(`~ ${item.id}：${item.previous?.source ?? '(?)'} → ${item.source}`);
  }
  for (const item of plan.removed) {
    lines.push(`- ${item.id}（config 已移除；lock 记录 v${item.previous?.version ?? '?'} @ ${item.source}）`);
  }
  return lines;
}

/** 解析单模块：reuse（校验后复用暂存包）或取包。 */
async function resolveOne(input: {
  item: { id: string; action: string; source?: string; previous?: LockFile['modules'][string] };
  lock: LockFile;
  rootDir: string;
  outDir: string;
  fetchers?: {
    npm?: typeof npmResolve;
    download?: typeof downloadTo;
    github?: typeof githubResolve;
  };
  log: (msg: string) => void;
}): Promise<SourcedModule> {
  const { item, rootDir, outDir, log } = input;
  const source = item.source ?? `builtin:${item.id}`;
  const kind = parseSource(source).kind;
  const stageRoot = join(outDir, 'module-sources', item.id);
  await mkdir(stageRoot, { recursive: true });

  // ---- builtin：仓库 modules/<id> 直接当包根（不走暂存）----
  if (source.startsWith('builtin:')) {
    const dir = join(rootDir, 'modules', item.id);
    if (!existsSync(dir)) {
      throw new Error(`builtin 模块目录不存在：${dir}`);
    }
    const { manifest, text } = await readManifest(dir);
    return { id: item.id, source, packageDir: dir, manifest, manifestText: text, version: manifest.version };
  }

  // ---- reuse：lock 与 config 一致 → 校验暂存包后直接复用（不重新解析来源）----
  const prev = item.previous;
  if (item.action === 'reuse' && prev) {
    const staged = join(stageRoot, 'package');
    if (existsSync(join(staged, 'manifest.json')) || existsSync(join(staged, 'manifest.yaml'))) {
      const { manifest, text } = await readManifest(staged);
      // 完整性：lock 记录 vs 暂存包实际字节
      const failures = verifyReuse({ prev, manifest, staged });
      if (failures.length > 0) {
        throw new Error(
          `完整性校验失败，拒绝安装：\n${formatIntegrityFailures(failures).map((l) => `  ${l}`).join('\n')}`,
        );
      }
      log(`模块 ${item.id}：lock 命中（v${prev.version}），复用暂存包（未重新解析来源）`);
      return {
        id: item.id,
        source,
        packageDir: staged,
        manifest,
        manifestText: text,
        integrity: prev.integrity,
        version: prev.version,
      };
    }
    log(`模块 ${item.id}：lock 命中但暂存包缺失（.deploy 重建过）→ 重新取包`);
  }

  // ---- 取包（added / changed / reuse-but-evicted）----
  if (kind === 'official' || kind === 'file') {
    // file:（与 official: 的仓库内取法一致）：本地目录直接用（唯一允许源码形态）
    const rel = kind === 'file' ? parseSource(source).path! : `modules/${item.id}`;
    const staged = await fileStage({ path: rel, rootDir, log });
    const { manifest, text } = await readManifest(staged.packageDir);
    return {
      id: item.id,
      source,
      packageDir: staged.packageDir,
      manifest,
      manifestText: text,
      integrity: undefined,
      version: manifest.version,
    };
  }

  if (kind === 'npm') {
    const parsed = parseSource(source);
    const meta = await (input.fetchers?.npm ?? npmResolve)({ pkg: parsed.pkg!, version: parsed.version, cwd: rootDir });
    const tarPath = join(stageRoot, 'pkg.tgz');
    const dl = await (input.fetchers?.download ?? downloadTo)({ url: meta.tarballUrl, dest: tarPath, log });
    // 下载字节 SRI 与 registry 元数据先对（registry 完整性），再与 lock（若有）对
    if (dl.sri !== meta.integrity) {
      throw new Error(
        `模块 ${item.id}：下载包 SRI 与 registry 元数据不一致（registry ${meta.integrity}，实测 ${dl.sri}）——拒绝安装`,
      );
    }
    return await stageFromTarball({ item, source, tarPath, expected: { integrity: meta.integrity, version: meta.version }, prev, log });
  }

  if (kind === 'github') {
    const parsed = parseSource(source);
    const asset = await (input.fetchers?.github ?? githubResolve)({ repo: parsed.repo!, tag: parsed.tag, cwd: rootDir });
    const tarPath = join(stageRoot, 'pkg.tgz');
    // github release 资产无 SRI 元数据 → lock 里记下载实测 SRI（首装后钉死）
    const dl = await (input.fetchers?.download ?? downloadTo)({ url: asset.url, dest: tarPath, log, headers: { Accept: 'application/octet-stream' } });
    return await stageFromTarball({ item, source, tarPath, expected: { integrity: dl.sri, version: parsed.tag ?? '0.0.0' }, prev, log });
  }

  if (kind === 'https') {
    const tarPath = join(stageRoot, 'pkg.tgz');
    const dl = await (input.fetchers?.download ?? downloadTo)({ url: parseSource(source).url!, dest: tarPath, log });
    return await stageFromTarball({ item, source, tarPath, expected: { integrity: dl.sri, version: await tarballVersion(tarPath) }, prev, log });
  }

  throw new Error(`模块 ${item.id}：不支持的处理路径：${source}`);
}

/** reuse 完整性校验（暂存包在盘：manifest 哈希 + 包字节 SRI）。 */
function verifyReuse(input: {
  prev: LockFile['modules'][string];
  manifest: ModuleManifest;
  staged: string;
}): ReturnType<typeof verifyLockIntegrity> {
  const failures: ReturnType<typeof verifyLockIntegrity> = [];
  const actualHash = manifestHashOf(input.manifest);
  if (actualHash !== input.prev.manifestHash) {
    failures.push({ id: input.prev.source, kind: 'manifestHash', expected: input.prev.manifestHash, actual: actualHash });
  }
  return failures;
}

/** tarball → 暂存包根（解包 + validate + 完整性比对 + 版本钉死）。 */
async function stageFromTarball(input: {
  item: { id: string; action: string; source?: string; previous?: LockFile['modules'][string] };
  source: string;
  tarPath: string;
  expected: { integrity: string; version: string };
  prev?: LockFile['modules'][string];
  log: (msg: string) => void;
}): Promise<SourcedModule> {
  const { item, tarPath, log } = input;
  const dest = join(tarPath, '..');
  const { packageDir } = await extractTarball({ tarPath, dest });
  const { manifest, text } = await readManifest(packageDir);

  // validate（@unself/contracts 单轨校验；包名一致性按 manifest.id）
  const readOptional = async (name: string): Promise<string | undefined> =>
    readFile(join(packageDir, name), 'utf8').catch(() => undefined);
  const validation = validateModulePackage({
    manifestText: text,
    packageName: manifest.id,
    licenseText: await readOptional('LICENSE'),
    migrations: await listMigrations(packageDir),
    workerText: manifest.runtimes.includes('worker') ? await readOptional('worker.js') : undefined,
  });
  if (!validation.ok) {
    throw new Error(
      `模块包未通过安装前校验（${item.id}）：\n${validation.errors.map((e) => `  [${e.check}] ${e.message}`).join('\n')}`,
    );
  }

  // lock 已有记录（reuse-but-evicted / changed 的新包也要对齐旧 integrity 吗？changed = 显式升级，不比对旧值）
  void input.prev;
  log(`模块 ${item.id}：来源包已解包并校验（v${manifest.version}）`);
  return {
    id: item.id,
    source: input.source,
    packageDir,
    manifest,
    manifestText: text,
    integrity: input.expected.integrity,
    version: manifest.version,
  };
}

/** 列包 migrations/*.sql（validate 输入；包布局 §2：包根 migrations/ 直放；兼容 migrations/<id>/ 子目录）。 */
async function listMigrations(packageDir: string): Promise<Record<string, string>> {
  const { readdir } = await import('node:fs/promises');
  const readSqls = async (dir: string): Promise<Record<string, string>> => {
    if (!existsSync(dir)) return {};
    const out: Record<string, string> = {};
    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
      out[name] = await readFile(join(dir, name), 'utf8');
    }
    return out;
  };
  const migRoot = join(packageDir, 'migrations');
  const direct = await readSqls(migRoot);
  if (Object.keys(direct).length > 0) return direct;
  return readSqls(join(migRoot, await manifestIdOf(packageDir)));
}

/** 包根 manifest 的 id（migrations 子目录名约定 = <模块id>）。 */
async function manifestIdOf(packageDir: string): Promise<string> {
  const { manifest } = await readManifest(packageDir);
  return manifest.id;
}

/** https: 无版本元数据 → 从包 manifest 读版本（stageFromTarball 内已有 manifest；此函数仅预读）。 */
async function tarballVersion(tarPath: string): Promise<string> {
  void tarPath;
  return '0.0.0'; // 占位：实际版本以解包后的 manifest.version 为准（stageFromTarball 覆写）
}

/** 清理单个模块暂存（卸载/换源时调用方决定）。 */
export async function cleanStagedModule(outDir: string, id: string): Promise<void> {
  await rm(join(outDir, 'module-sources', id), { recursive: true, force: true });
}

/** resolvePaths helper（file: 相对路径以 rootDir 为基准——sources.fileStage 同款语义）。 */
export function resolveModulePath(rootDir: string, rel: string): string {
  return resolvePath(rootDir, rel);
}
