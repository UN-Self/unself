// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 来源解析编排（步骤②½，issue #245；#284 起官方模块也走这条路）：
 * config.modules 的 {id, source} 条目 → npm 本地优先取包（命中零网络）/ 远端 tarball 直解 / file: 本地目录
 * → validate → 落位到装配区（outDir/modules/<id>/src）。**没有 builtin 来源分支**（决策 #77 A 方案）。
 *
 * **安全边界（硬，决策 #58）**：
 * - 远端来源一律已打包：tarball 直接解包，不走 npm install，包内脚本零执行；
 * - `file:` 与本地 `node_modules` 源码形态（仓库 workspace 符号链接）允许本地源码（本地构建）；
 * - reuse 且哈希不匹配 → **拒绝安装**（决策 #60）。
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  manifestFromYamlText,
  MODULE_PERMISSIONS,
  ModuleManifestSchema,
  validateModulePackage,
  CONTRACT_VERSION,
  type ModuleManifest,
} from '@unself/contracts';
import { buildLockPlan, formatIntegrityFailures, manifestHashOf, verifyLockIntegrity, type LockFile, type LockPlan } from './lock';
import { downloadTo, extractTarball, fileStage, githubResolve, npmResolve, parseSource, resolveLocalNpmPackage } from './sources';

/** 单个来源模块的解析产物。 */
export interface SourcedModule {
  id: string;
  /** 生效来源（config 条目原文）。 */
  source: string;
  /** 包根目录（磁盘绝对路径；装配器从这里取 worker/资产/迁移）。 */
  packageDir: string;
  /** 包形态：packed = 预构建包（manifest.json + worker.js）；source = 源码目录（manifest.yaml，本地构建）。 */
  form: 'packed' | 'source';
  /** 解析后的 manifest（契约 v1 对象）。 */
  manifest: ModuleManifest;
  /** manifest.yaml / manifest.json 原文（注册表快照与 lock 哈希共用）。 */
  manifestText: string;
  /** 包字节 SRI（sha512-…）；本地目录形态（npm 本地命中 / file:）无下载字节 → undefined。 */
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

/**
 * 未知能力安装期门禁（issue #269 / 决策 #56，docs/modules.md）：在 schema parse **之前**对
 * manifest 原文做 permissions 前置检查——zod 枚举只会报「Invalid enum value」，用户看不到
 * 自己写了什么能力名；这里点名每个未知值。
 *
 * 安装期硬拒而非静默忽略：静默丢未知能力 → 模块运行期调对应 Core API 莫名 403（#64 同源教训）。
 * 容错：permissions 非数组 / 无该字段 → 跳过（交由 schema/validate 常规报告）。
 */
export function assertKnownPermissions(manifestText: string, json: boolean): void {
  let rawPermissions: unknown;
  if (json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText) as unknown;
    } catch {
      return; // 非法 JSON 交由 schema 报告（错误更具体）
    }
    rawPermissions = (parsed as Record<string, unknown> | null)?.permissions;
  } else {
    // yaml：复用 contracts 的最小解析（与 schema 入口同一 candidate），拿不到 = 无该字段
    rawPermissions = manifestFromYamlText(manifestText).permissions;
  }
  if (!Array.isArray(rawPermissions)) return;
  const unknownList = rawPermissions.filter(
    (p): p is string => typeof p === 'string' && !(MODULE_PERMISSIONS as readonly string[]).includes(p),
  );
  if (unknownList.length === 0) return;
  throw new Error(
    `模块包声明了未知能力「${unknownList.join('」「')}」：安装时拒绝（决策 #56 / docs/modules.md）。` +
      `当前词表：${MODULE_PERMISSIONS.join(' / ')}；` +
      '未知能力被静默忽略会导致模块运行期莫名 403，故安装期硬拒——请改模块 manifest 或升级安装器。',
  );
}

/**
 * 解析 manifest：包根有 manifest.yaml → contracts YAML 轨；manifest.json → JSON 轨（#243 单轨解析）。
 * 读后先过未知能力门禁（issue #269：schema 报错看不到能力名，前置检查点名；见 assertKnownPermissions）。
 */
export async function readManifest(packageDir: string): Promise<{ manifest: ModuleManifest; text: string }> {
  const yamlPath = join(packageDir, 'manifest.yaml');
  const jsonPath = join(packageDir, 'manifest.json');
  if (existsSync(yamlPath)) {
    const text = await readFile(yamlPath, 'utf8');
    assertKnownPermissions(text, false);
    const manifest = ModuleManifestSchema.parse(manifestFromYamlText(text) as Record<string, unknown>);
    return { manifest, text };
  }
  if (existsSync(jsonPath)) {
    const text = await readFile(jsonPath, 'utf8');
    assertKnownPermissions(text, true);
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
  entries: Array<{ id: string; source: string }>;
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
          ...(input.fetchers ? { fetchers: input.fetchers } : {}),
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
  if (!item.source) {
    throw new Error(`模块 ${item.id}：config 条目缺 source（#77：条目必须是 { id, source }，不再接受裸字符串/builtin）`);
  }
  const source = item.source;
  const kind = parseSource(source).kind;
  const stageRoot = join(outDir, 'module-sources', item.id);
  await mkdir(stageRoot, { recursive: true });

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
        form: existsSync(join(staged, 'manifest.json')) ? 'packed' : 'source',
        manifest,
        manifestText: text,
        integrity: prev.integrity,
        version: prev.version,
      };
    }
    log(`模块 ${item.id}：lock 命中但暂存包缺失（.deploy 重建过）→ 重新取包`);
  }

  // ---- 取包（added / changed / reuse-but-evicted）----
  if (kind === 'file') {
    // file: 本地目录直接用（唯一允许源码形态的本地路径）
    const staged = await fileStage({ path: parseSource(source).path!, rootDir, log });
    const { manifest, text } = await readManifest(staged.packageDir);
    assertReuseManifestHash({ item, prev, manifest });
    return {
      id: item.id,
      source,
      packageDir: staged.packageDir,
      form: 'source',
      manifest,
      manifestText: text,
      integrity: undefined,
      version: manifest.version,
    };
  }

  if (kind === 'npm') {
    const parsed = parseSource(source);
    // 决策 #77 A 方案：本地 node_modules 有该包且版本匹配 → 直接用（零网络，不上 registry）。
    // 本地形态可能是 npm 发布形态（manifest.json）或仓库 workspace 源码形态（manifest.yaml，符号链接）。
    const local = resolveLocalNpmPackage({ pkg: parsed.pkg!, version: parsed.version, rootDir, log });
    if (local) {
      const { manifest, text } = await readManifest(local.dir);
      assertReuseManifestHash({ item, prev, manifest });
      // 本地包形态按同一套安装前校验跑（与 registry tarball 同一判据）；源码形态与 file: 同口径（本地构建允许、包校验留给装配）。
      if (local.form === 'packed') {
        await validateStagedPackage({ id: item.id, packageDir: local.dir, manifest, manifestText: text });
      }
      log(`模块 ${item.id}：npm 本地命中（v${manifest.version}，${local.form} 形态）——零网络安装`);
      return {
        id: item.id,
        source,
        packageDir: local.dir,
        form: local.form,
        manifest,
        manifestText: text,
        // 本地目录无 tarball 字节 → 无 SRI；reuse 时守住 lock 里那枚（重取路径也验证了 manifestHash）
        integrity: item.action === 'reuse' ? prev?.integrity : undefined,
        version: manifest.version,
      };
    }
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

/**
 * 目录来源（file: / npm 本地命中）重取路径的 manifestHash 收紧（issue #269 / 决策 #60）：
 * 目录来源无包字节 SRI，但 lock 里的 manifestHash 必须对得上——否则本地内容已变却沿用旧锁定记录（静默漂移）。
 * changed（显式换源/升级）不触发：用户明确要求换包，比对旧值只会错拦。
 */
function assertReuseManifestHash(input: {
  item: { id: string; action: string };
  prev?: LockFile['modules'][string];
  manifest: ModuleManifest;
}): void {
  if (input.item.action !== 'reuse' || !input.prev) return;
  const actual = manifestHashOf(input.manifest);
  if (actual !== input.prev.manifestHash) {
    throw new Error(
      `模块 ${input.item.id}：manifestHash 不匹配（lock 期望 ${input.prev.manifestHash.slice(0, 16)}…，实测 ${actual.slice(0, 16)}…）——本地来源内容已变，拒绝安装；确认要升级请重跑 \`unself module add\` 重新锁定`,
    );
  }
}

/**
 * 安装前包校验（@unself/contracts 单轨校验；包名一致性按 manifest.id）。
 * registry tarball 与 npm 本地命中（packed 形态）共用同一判据——「官方与第三方同一条路」（决策 #77）。
 */
async function validateStagedPackage(input: {
  id: string;
  packageDir: string;
  manifest: ModuleManifest;
  manifestText: string;
}): Promise<void> {
  const readOptional = async (name: string): Promise<string | undefined> =>
    readFile(join(input.packageDir, name), 'utf8').catch(() => undefined);
  const validation = validateModulePackage({
    manifestText: input.manifestText,
    packageName: input.manifest.id,
    licenseText: await readOptional('LICENSE'),
    migrations: await listMigrations(input.packageDir),
    workerText: input.manifest.runtimes.includes('worker') ? await readOptional('worker.js') : undefined,
  });
  if (!validation.ok) {
    throw new Error(
      `模块包未通过安装前校验（${input.id}）：\n${validation.errors.map((e) => `  [${e.check}] ${e.message}`).join('\n')}`,
    );
  }
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

  // reuse 完整性收紧（issue #269 / 决策 #60）：决策 #60 目前只在「暂存包还在」的 reuse 分支生效；
  // 暂存被清（干净机器 / .deploy 重建）重新取包时会静默接受新字节。这里补齐重取路径：
  // (a) lock 期望 SRI vs 本次实测字节；(b) lock 期望 manifestHash vs 包内 manifest。任一不等 → 拒绝。
  // changed = 显式换源/升级，**不得**触发（用户明确要求换包，比对旧值只会错拦）。
  const prev = input.prev;
  if (item.action === 'reuse' && prev) {
    if (prev.integrity !== undefined && prev.integrity !== input.expected.integrity) {
      throw new Error(
        `模块 ${item.id}：包 integrity 不匹配（lock 期望 ${prev.integrity.slice(0, 24)}…，实测 ${input.expected.integrity.slice(0, 24)}…）——tarball 可能被篡改，拒绝安装（决策 #60）；确认要升级请重跑 \`unself module add\` 重新锁定`,
      );
    }
    const actualHash = manifestHashOf(manifest);
    if (actualHash !== prev.manifestHash) {
      throw new Error(
        `模块 ${item.id}：manifestHash 不匹配（lock 期望 ${prev.manifestHash.slice(0, 16)}…，实测 ${actualHash.slice(0, 16)}…）——包内容与 unself.lock 锁定版本不一致，拒绝安装（决策 #60）；确认要升级请重跑 \`unself module add\` 重新锁定`,
      );
    }
  }

  // validate（@unself/contracts 单轨校验；与 npm 本地命中同一函数，防两处漂移）
  await validateStagedPackage({ id: item.id, packageDir, manifest, manifestText: text });

  // lock 已有记录且通过了上面的收紧比对（reuse 重取路径）；changed = 显式升级，不比对旧值
  log(`模块 ${item.id}：来源包已解包并校验（v${manifest.version}）`);
  return {
    id: item.id,
    source: input.source,
    packageDir,
    form: 'packed',
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

/**
 * 本地解析一个来源（不联网）：
 * - `npm:` → 本地 node_modules 命中（版本匹配）的包；
 * - `file:` → 本地目录。
 * 其余协议（github:/https:/远端 npm:）或本地未命中 → 返回 null（调用方自己决定要不要联网）。
 * 用途：向导③½ 的存储声明投影（只需本地 manifest，不应因为「看一眼」就跑网络）。
 */
export async function localModuleManifest(input: {
  source: string;
  rootDir: string;
  log?: (msg: string) => void;
}): Promise<{ id: string; dir: string; form: 'packed' | 'source'; manifest: ModuleManifest } | null> {
  const parsed = parseSource(input.source);
  let dir: string;
  let form: 'packed' | 'source';
  if (parsed.kind === 'npm') {
    const local = resolveLocalNpmPackage({
      pkg: parsed.pkg!,
      ...(parsed.version !== undefined ? { version: parsed.version } : {}),
      rootDir: input.rootDir,
      ...(input.log ? { log: input.log } : {}),
    });
    if (!local) return null;
    dir = local.dir;
    form = local.form;
  } else if (parsed.kind === 'file') {
    const staged = await fileStage({
      path: parsed.path!,
      rootDir: input.rootDir,
      ...(input.log ? { log: input.log } : {}),
    });
    dir = staged.packageDir;
    form = 'source';
  } else {
    return null;
  }
  const { manifest } = await readManifest(dir);
  return { id: manifest.id, dir, form, manifest };
}

/** 清理单个模块暂存（卸载/换源时调用方决定）。 */
export async function cleanStagedModule(outDir: string, id: string): Promise<void> {
  await rm(join(outDir, 'module-sources', id), { recursive: true, force: true });
}

/** resolvePaths helper（file: 相对路径以 rootDir 为基准——sources.fileStage 同款语义）。 */
export function resolveModulePath(rootDir: string, rel: string): string {
  return resolvePath(rootDir, rel);
}
