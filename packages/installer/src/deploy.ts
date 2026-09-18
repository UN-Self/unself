// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 部署执行桥（薄）：向导④与 `unself deploy` 都经由 runDeploy。
 * 职责边界：读实例目录 → configOverride 进九步引擎（不改配置文件语义）→ 进度转发。
 * 真机路径依赖 deploy/cloudflare 的 runNineSteps（workspace 依赖，#242 薄壳方案）。
 */
import { parseUnselfConfigText, type UnselfConfig } from '@unself/deploy-cloudflare';
import { readFileSync } from 'node:fs';
import { instanceLayout } from './index';

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

/** 读实例配置并应用向导覆盖（只改内存副本，不回写文件——交互结果不落盘同 CLI 语义）。 */
export function effectiveConfig(instancePath: string, override?: { domain?: string; modules?: string[] }): UnselfConfig {
  const { configPath } = instanceLayout(instancePath.replace(/[/\\]unself$/, ''));
  const text = readFileSync(configPath, 'utf8');
  const base = parseUnselfConfigText(text);
  return {
    ...base,
    domain: override?.domain !== undefined ? override.domain : base.domain,
    modules: override?.modules ?? base.modules,
  };
}

/**
 * 真机部署（九步引擎整包调用，语义零改动）。
 * 注意：本函数在「干净 HOME npx 冒烟」与单测中不会执行（无 token/无网络）；
 * 进度输出经 onEvent 转给向导事件流，失败直接抛错（向导壳转三要素）。
 */
export async function runDeploy(input: RunDeployOptions): Promise<DeployResult> {
  const { runNineSteps, progressTracker } = await import('@unself/deploy-cloudflare');
  const log = (msg: string): void => input.onEvent?.(msg);
  const rep = progressTracker({ total: 9, out: log });
  const configOverride = effectiveConfig(input.instancePath, { domain: input.domain, modules: input.modules });
  const summary = await runNineSteps({
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
