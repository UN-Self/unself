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
import { instanceLayout } from './lib/dir';

export interface RunDeployOptions {
  instancePath: string;
  /** 向导②③的决策（缺省 = 读实例目录 unself.config.jsonc）。 */
  domain?: string;
  modules?: string[];
  /** ③½ 用户存储选择（#55）：模块 id → 四级之一；进引擎后写进各模块 manifest 快照。 */
  storageChoices?: Record<string, string>;
  onEvent?: (text: string) => void;
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
  override?: { domain?: string; modules?: string[] },
): Promise<import('@unself/deploy-cloudflare').UnselfConfig> {
  const engine = await loadEngine();
  const { configPath } = instanceLayout(instancePath.replace(/[/\\]unself$/, ''));
  const text = readFileSync(configPath, 'utf8');
  const base = engine.parseUnselfConfigText(text);
  return {
    ...base,
    domain: override?.domain !== undefined ? override.domain : base.domain,
    modules: override?.modules ?? base.modules,
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
    // rootDir = 实例目录的父目录（引擎在 rootDir 下找 unself.config.jsonc / modules/ / services/）。
    rootDir: input.instancePath.replace(/[/\\]unself$/, ''),
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
