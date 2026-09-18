// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 部署执行桥（薄）：向导④与 `unself deploy` 都经由 runDeploy。
 * 引擎（@unself/deploy-cloudflare）一律动态加载：CLI 核心（init/list/use/…）与 Web 向导
 * 页面/状态机零引擎依赖——独立安装制品里也能跑；真正装配时才需要引擎在依赖里
 * （workspace 开发装 / 发布后 registry 装均满足）。
 * 职责边界：读实例目录 → configOverride 进九步引擎（不改配置文件语义）→ 进度转发。
 */
import { readFileSync } from 'node:fs';
import { instanceLayout } from './lib/dir';

export interface RunDeployOptions {
  instancePath: string;
  /** 向导②③的决策（缺省 = 读实例目录 unself.config.jsonc）。 */
  domain?: string;
  modules?: string[];
  onEvent?: (text: string) => void;
}

export interface DeployResult {
  baseUrl: string;
  setupToken: string | null;
}

/** 九步引擎模块形状（动态加载目标；workspace 内可直接 import 供类型检查）。 */
type Engine = typeof import('@unself/deploy-cloudflare');

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
  const summary = await engine.runNineSteps({
    // rootDir = 实例目录的父目录（引擎在 rootDir 下找 unself.config.jsonc / modules/ / services/）。
    rootDir: input.instancePath.replace(/[/\\]unself$/, ''),
    configOverride,
    reporter: rep.reporter,
  });
  rep.complete();
  return {
    baseUrl: summary.baseUrl,
    // sealed（已有管理员）无 setupUrl；有则给深链。
    setupToken: 'setupUrl' in summary.setup && summary.setup.setupUrl ? (summary.setup.setupUrl.split('token=')[1] ?? null) : null,
  };
}
