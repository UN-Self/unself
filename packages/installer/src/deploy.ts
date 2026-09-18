// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 部署执行桥（薄）：向导④与 `unself deploy` 都经由 runDeploy。
 * 引擎（@unself/deploy-cloudflare）经动态 import 调用：#257 起它**随安装器 bundle 进 dist/unself.mjs**
 * （安装器 tarball 零运行期依赖），仓库开发形态下则由 workspace 链接提供——两种形态同一份代码。
 * 引擎运行期消费的装配产物（core/shell/SDK/builtin 模块包）随包分发在 `<安装器>/dist/artifacts`，
 * `rootDir`（实例目录的父目录）只当**输出目录**（.deploy/、unself.lock）。
 * 职责边界：读实例目录 → configOverride 进九步引擎（不改配置文件语义）→ 进度转发。
 */
import { readFileSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { instanceLayout } from './lib/dir';

/**
 * 模块条目输入（#269）：字符串 = builtin 目录形态；对象 = 带来源（决策 #58）。
 * 与引擎 `UnselfConfig.modules` 同形。
 */
export type ModuleEntryInput = string | { id: string; source?: string; storage?: { declaration: string } };

export interface RunDeployOptions {
  instancePath: string;
  /** 向导②③的决策（缺省 = 读实例目录 unself.config.jsonc）。 */
  domain?: string;
  /** ③ 确认的模块条目（含来源；#269）。 */
  modules?: ModuleEntryInput[];
  /** ③½ 用户存储选择（#55）：模块 id → 四级之一；进引擎后写进各模块 manifest 快照。 */
  storageChoices?: Record<string, string>;
  onEvent?: (text: string) => void;
  /**
   * 向导①粘贴的 API Token（#272）：只进本次进程内存/本次 REST 调用，不落盘、不回显、不进状态。
   * 显式给了就用它建 RestClient（优先于环境变量）；缺省 = 引擎默认凭证优先级（env → OAuth）。
   */
  token?: string;
  /** 撞车守卫放行开关（#272）：显式接管既有同名资源。 */
  allowAdopt?: boolean;
  /**
   * 来源漂移已确认（#269）：向导③已在装配前展示「将要装什么」且用户点确认 → true；
   * CLI 走 `--yes`。false/缺省 = 有漂移即抛 SourceDriftError 列 diff（#245 安全闸门不变）。
   */
  yes?: boolean;
  /**
   * @internal 测试注入口（#269）：透传给引擎 `runNineSteps` 的额外选项（client / http / buildShell /
   * artifactRoot / fetchers 等）。`rootDir` 与 `configOverride` 仍由本桥确定，不被透传覆盖。
   */
  engineOverrides?: Partial<Parameters<Engine['runNineSteps']>[0]>;
}

/** 实例资源名预览（#272）：向导/init 展示「本实例会占用哪些 CF 资源名」。 */
export interface InstanceResourcePreview {
  /** 实例命名空间；undefined = 历史形态 unself-*。 */
  namespace?: string;
  names: Array<{ kind: string; name: string }>;
}

/**
 * 读实例配置并推出本实例会占用的资源名（纯预览；不建任何资源）。
 * 由引擎的 previewResourceNames 同源派生，安装器不重复实现命名规则。
 * @param moduleIdsOverride ③ 步改动后的模块 id 清单（#269：改模块后重算预览，而非沿用启动时快照）。
 */
export async function previewInstanceResources(
  instancePath: string,
  moduleIdsOverride?: string[],
): Promise<InstanceResourcePreview> {
  const engine = await loadEngine();
  const cfg = await effectiveConfig(instancePath);
  const moduleIds = moduleIdsOverride
    ?? (cfg.modules as Array<string | { id: string }>).map((m) => (typeof m === 'string' ? m : m.id));
  const bucket = cfg.storage.provider === 'r2' ? cfg.storage.bucket : undefined;
  const names = engine.previewResourceNames({
    ...(cfg.namespace !== undefined ? { namespace: cfg.namespace } : {}),
    moduleIds,
    ...(bucket !== undefined ? { bucket } : {}),
  });
  return { ...(cfg.namespace !== undefined ? { namespace: cfg.namespace } : {}), names };
}

/** 四级词表（与 @unself/contracts StorageLevelSchema 同源语义；向导壳零引擎依赖故内联）。 */
const STORAGE_LEVELS = ['core', 'shared', 'dedicated', 'external'] as const;

/**
 * 读实例所属模块的 storage 声明（#55）：
 * 返回向导③½ 的单选数据（id + accepts + preferred）。
 * 两个来源（#257）：产物形态读安装器包内 `<artifacts>/modules/<id>/manifest.json`；
 * 仓库形态读 `rootDir/modules/<id>/manifest.yaml`——干净机器没有仓库，必须优先产物。
 * 与九步引擎的 discoverModules 同源（模块目录的两种形态同规）。
 */
export async function wizardStorageOptions(rootDir: string): Promise<Array<{ id: string; accepts: string[]; preferred?: string }>> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  let modulesDir = join(rootDir, 'modules');
  let packageForm = false;
  try {
    const engine = await loadEngine();
    const artifacts = engine.resolveArtifactRoots({ rootDir });
    if (artifacts) {
      modulesDir = artifacts.modulesDir;
      packageForm = true;
    }
  } catch {
    // 引擎不可用（发布包已内置引擎；此处僅兼容开发态缺依赖）→ 退回仓库形态扫描
  }
  if (!existsSync(modulesDir)) return [];
  const out: Array<{ id: string; accepts: string[]; preferred?: string }> = [];
  for (const entry of await readdir(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(modulesDir, entry.name, packageForm ? 'manifest.json' : 'manifest.yaml');
    if (!existsSync(manifestPath)) continue;
    // 轻量提取 storage.accepts/preferred：不引引擎（installer 零引擎依赖），
    // 用 @unself/contracts 的 manifestFromYamlText 单轨解析（防解析分叉）。
    try {
      const { manifestFromYamlText } = await import('@unself/contracts');
      const text = await readFile(manifestPath, 'utf8');
      const candidate = (packageForm ? JSON.parse(text) : manifestFromYamlText(text)) as {
        id?: string;
        storage?: { accepts?: string[]; preferred?: string };
      };
      const id = typeof candidate.id === 'string' ? candidate.id : entry.name;
      const accepts = (candidate.storage?.accepts ?? ['core']).filter((l): l is (typeof STORAGE_LEVELS)[number] =>
        (STORAGE_LEVELS as readonly string[]).includes(l),
      );
      out.push({
        id,
        accepts: accepts.length > 0 ? accepts : ['core'],
        ...(candidate.storage?.preferred ? { preferred: candidate.storage.preferred } : {}),
      });
    } catch {
      // 解析失败（非契约形态）：降级为 core 单选，不阻断向导启动
      out.push({ id: entry.name, accepts: ['core'] });
    }
  }
  return out;
}

export interface DeployResult {
  baseUrl: string;
  setupToken: string | null;
}

/** 九步引擎模块形状（动态加载目标；workspace 内可直接 import 供类型检查）。 */
type Engine = typeof import('@unself/deploy-cloudflare');
type EngineUnselfConfig = import('@unself/deploy-cloudflare').UnselfConfig;

async function loadEngine(): Promise<Engine> {
  try {
    return await import('@unself/deploy-cloudflare');
  } catch {
    throw new Error(
      '部署引擎不可用（@unself/deploy-cloudflare 未安装）：实例目录与配置都已就绪；'
        + '在仓库 workspace 内运行，或使用发布后含引擎依赖的安装包。',
    );
  }
}

/** 读实例配置并应用向导覆盖（只改内存副本，不回写文件——交互结果不落盘同 CLI 语义）。 */
export async function effectiveConfig(
  instancePath: string,
  override?: { domain?: string; modules?: ModuleEntryInput[] },
): Promise<import('@unself/deploy-cloudflare').UnselfConfig> {
  const engine = await loadEngine();
  const { configPath } = instanceLayout(instancePath.replace(/[/\\]unself$/, ''));
  const text = readFileSync(configPath, 'utf8');
  const base = engine.parseUnselfConfigText(text);
  return {
    ...base,
    domain: override?.domain !== undefined ? override.domain : base.domain,
    // 向导传入的条目形态比引擎类型宽松（对象条目可只有 id + storage 选择）——装配期会归一化。
    modules: (override?.modules ?? base.modules) as EngineUnselfConfig['modules'],
  };
}

/**
 * 真机部署（九步引擎整包调用，语义零改动）。
 * 进度输出经 onEvent 转给向导事件流；失败直接抛错（向导壳转三要素）。
 */
export async function runDeploy(input: RunDeployOptions): Promise<DeployResult> {
  const engine = await loadEngine();
  const log = (msg: string): void => input.onEvent?.(msg);
  const rep = engine.progressTracker({ total: 9, out: log });
  // 向导①粘贴的 token（#272）：建显式 RestClient（不落 process.env；本次调用结束即随作用域消失）。
  const client = input.token ? new engine.RestClient({ token: input.token }) : undefined;
  const configOverride = await effectiveConfig(input.instancePath, { domain: input.domain, modules: input.modules });
  // ③½ 用户存储选择（#55）写进各模块 manifest 快照：declaration 进注册表快照，
  // 引擎据此决定四级落点（core 代理 / shared 建表 / dedicated 独立库 / external 接线）。
  const modulesOverride = input.storageChoices
    ? (configOverride.modules ?? []).map((entry) => {
        const id = typeof entry === 'string' ? entry : entry.id;
        const source = typeof entry === 'string' ? undefined : entry.source;
        const choice = input.storageChoices?.[id];
        if (!choice) {
          return entry;
        }
        if (!(STORAGE_LEVELS as readonly string[]).includes(choice)) {
          throw new Error(
            `模块 ${id} 的存储选择「${choice}」不是四级词表之一（core/shared/dedicated/external）`,
          );
        }
        return source !== undefined
          ? { id, source, storage: { declaration: choice } }
          : ({ id, storage: { declaration: choice } } as unknown as EngineUnselfConfig['modules'][number]);
      })
    : configOverride.modules;
  const summary = await engine.runNineSteps({
    ...(input.engineOverrides ?? {}),
    // rootDir = **实例目录本身**（#269 修正）：实例的 unself.config.jsonc / unself.lock / .deploy 都在
    // 实例目录内（与 lib/dir.instanceLayout 同一约定），引擎才能读到 `module add` 写下的 lock——
    // 否则每次 `module add` 后 deploy 都会报「来源漂移未确认」。
    // 装配产物形态（发布包）下 rootDir 只当输出/记账目录；仓库开发形态请用引擎自己的 bin。
    rootDir: input.instancePath,
    ...(client ? { client } : {}),
    ...(input.allowAdopt ? { allowAdopt: true } : {}),
    ...(input.yes ? { yes: true } : {}),
    ...(modulesOverride !== configOverride.modules ? { configOverride: { ...configOverride, modules: modulesOverride } } : { configOverride }),
    reporter: rep.reporter,
  });
  rep.complete();
  return {
    baseUrl: summary.baseUrl,
    // sealed（已有管理员）无 setupUrl；有则给深链。
    setupToken: 'setupUrl' in summary.setup && summary.setup.setupUrl ? (summary.setup.setupUrl.split('token=')[1] ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// 来源预览 / token 真验 / `unself module pack|add`（#269）
// ---------------------------------------------------------------------------

/** 来源预览（向导③「将要装什么」与 `module add` 共用）。 */
export interface ModuleSourcePreview {
  id: string;
  source: string;
  kind: string;
  version: string;
  integrity?: string;
  /** 声明的能力（词表内；未知能力已在预览期被引擎拒绝，不会走到这里）。 */
  permissions: string[];
  storage: { accepts: string[]; preferred?: string };
  /** manifest 规范化哈希（写 unself.lock 用；与引擎 manifestHashOf 同源）。 */
  manifestHash: string;
  /** 解包后的包根（`module add` 据此把包放进暂存区，让 deploy 复用）。 */
  packageDir: string;
}

/**
 * 解析来源并返回「将要装什么」（来源/版本/SRI/permissions/落点）。
 * 未知能力 → 引擎抛人话错（点名能力），调用方在用户面展示并拒绝。
 */
export async function describeModuleSource(
  source: string,
  opts: { instancePath: string; log?: (msg: string) => void },
): Promise<ModuleSourcePreview> {
  const engine = await loadEngine();
  // cwd = 实例目录本身（#269）：与装配期引擎的 rootDir 同一基准，file: 相对路径在预览与装配两处解析一致。
  const rootDir = opts.instancePath;
  const artifacts = engine.resolveArtifactRoots({ rootDir });
  const preview = await engine.previewModuleSource({
    source,
    cwd: rootDir,
    artifacts,
    ...(opts.log ? { log: opts.log } : {}),
  });
  return {
    id: preview.id,
    source,
    kind: preview.kind,
    version: preview.version,
    ...(preview.integrity !== undefined ? { integrity: preview.integrity } : {}),
    permissions: [...preview.permissions],
    storage: {
      accepts: [...preview.storage.accepts],
      ...(preview.storage.preferred !== undefined ? { preferred: preview.storage.preferred } : {}),
    },
    manifestHash: engine.manifestHashOf(preview.manifest),
    packageDir: preview.packageDir,
  };
}

/** token 真验结论：invalid = CF 判定 token 无效；network/permission = 别的问题（不与「无效」混报）。 */
export interface TokenVerifyResult {
  ok: boolean;
  kind: 'valid' | 'invalid' | 'network' | 'permission';
  /** 给人看的一句话（invalid 分支含 CF 原话）。 */
  message: string;
}

/**
 * token 真验（决策依据：CF `GET /user/tokens/verify`，2026-09-18 实测端点）。
 * 形状校验只拦明显不对；真伪一律以此端点为准：无效 token 显示 CF 原话，
 * 网络/权限问题与「token 无效」分开报（#269 用户走查要求）。
 */
export async function verifyApiToken(token: string): Promise<TokenVerifyResult> {
  const engine = await loadEngine();
  const client = new engine.RestClient({ token, retries: 0, timeoutMs: 15_000 });
  try {
    const res = await client.get<{ id?: string; status?: string }>('/user/tokens/verify');
    const status = res.result?.status ?? 'active';
    return { ok: true, kind: 'valid', message: `Cloudflare 校验通过（token 状态：${status}）` };
  } catch (err) {
    const e = err as { message?: string; status?: number; code?: number; errors?: Array<{ code: number; message: string }> };
    const cfWords = (e.errors ?? []).map((x) => `${x.code} ${x.message}`).join('; ') || (e.message ?? String(err));
    const status = e.status ?? 0;
    const code = e.code ?? 0;
    if (status === 0) {
      return { ok: false, kind: 'network', message: `连不上 Cloudflare，token 没能校验（网络问题，不是 token 无效）：${cfWords}` };
    }
    if (status === 400 || code === 1000) {
      return { ok: false, kind: 'invalid', message: `Cloudflare 判定 token 无效：${cfWords}` };
    }
    if (status === 403 || code === 9109 || code === 9107) {
      return { ok: false, kind: 'permission', message: `token 本身可能有效，但权限不足（CF 原话：${cfWords}）——按向导①深链接补权限后重试` };
    }
    return { ok: false, kind: 'network', message: `token 校验没完成（不是「token 无效」）：${cfWords}` };
  }
}

/** `unself module add` 结果（打印/断言用）。 */
export interface AddModuleResult extends ModuleSourcePreview {
  configPath: string;
  lockPath: string;
  /** 是否因 `--as` 改写了实例内 id。 */
  renamed: boolean;
}

/**
 * `unself module add <source>`：预览（含未知能力门禁）→ 写 unself.config.jsonc 的 modules →
 * 把包放进装配暂存区（供 deploy lock 命中复用）→ 写 unself.lock（决策 #60：重跑一律用 lock）。
 * 这样紧接着的 `unself deploy` 不会因「来源漂移未确认」而报错，而是直接复用锁定内容。
 */
export async function addModuleSource(input: {
  instancePath: string;
  source: string;
  as?: string;
  log?: (msg: string) => void;
}): Promise<AddModuleResult> {
  const engine = await loadEngine();
  const rootDir = dirname(input.instancePath);
  const { configPath, lockPath } = instanceLayout(rootDir);
  const { addModuleToConfigText } = await import('./lib/config-edit');
  const { CONTRACT_VERSION } = await import('@unself/contracts');

  const cfgText = readFileSync(configPath, 'utf8');
  const preview = await describeModuleSource(input.source, {
    instancePath: input.instancePath,
    ...(input.log ? { log: input.log } : {}),
  });
  const id = input.as ?? preview.id;
  if (!/^[a-z][a-z0-9-]+$/.test(id)) {
    throw new Error(`模块 id 不合法：${id}（小写字母开头，小写字母/数字/连字符，至少 2 位）`);
  }
  const renamed = id !== preview.id;
  if (renamed) input.log?.(`实例内命名覆盖：${preview.id} → ${id}`);

  const nextConfig = addModuleToConfigText(cfgText, { id, source: input.source });
  await writeFile(configPath, nextConfig);

  // 暂存包（npm/github/https 有解包产物）：放到 deploy 的 reuse 查找位置
  // （引擎 outDir = <rootDir>/<DEPLOY_DIR>/module-sources/<id>，见 steps.ts），
  // 使紧随其后的 deploy 不再下载、且完整性受 lock 约束。
  if (preview.kind !== 'file') {
    const staged = join(input.instancePath, engine.DEPLOY_DIR, 'module-sources', id, 'package');
    await mkdir(dirname(staged), { recursive: true });
    await cp(preview.packageDir, staged, { recursive: true, force: true });
  }

  // lock：记来源/版本/SRI/manifestHash/契约版本（引擎 LockFileSchema 形状）。
  const lockText = readFileSync(lockPath, 'utf8');
  type EngineLockFile = import('@unself/deploy-cloudflare').LockFile;
  let lock: EngineLockFile;
  try {
    lock = engine.parseLockText(lockText);
  } catch {
    lock = engine.emptyLock();
  }
  lock.modules = {
    ...lock.modules,
    [id]: {
      source: input.source,
      version: preview.version,
      ...(preview.integrity !== undefined ? { integrity: preview.integrity } : {}),
      manifestHash: preview.manifestHash,
      contractVersion: CONTRACT_VERSION,
    },
  };
  await writeFile(lockPath, engine.serializeLock(lock));
  return { ...preview, configPath, lockPath, renamed };
}

/**
 * `unself module pack <dir>`：打包并返回 tgz 路径与 SRI。
 * 与 builtin 产物同一条路（引擎 `modulePackageFiles`），故 `file:` 与本地 tarball 结果一致。
 */
export async function packModule(input: { dir: string; outDir?: string; log?: (msg: string) => void }): Promise<{
  tarballPath: string;
  integrity: string;
  id: string;
  version: string;
  files: string[];
}> {
  const engine = await loadEngine();
  const result = await engine.packModuleDir({
    dir: input.dir,
    ...(input.outDir !== undefined ? { outDir: input.outDir } : {}),
    ...(input.log ? { log: input.log } : {}),
  });
  return {
    tarballPath: result.tarballPath,
    integrity: result.integrity,
    id: result.manifest.id,
    version: result.manifest.version,
    files: result.files.map((f) => f.name),
  };
}
