// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块可达 URL 的形态决策（#273）：一条真值源，供注册表 entry / iframe 装载 /
 * 步骤⑨冒烟 / 主题体检四处共用——任何一处自己拼 URL 都会漂移到「不可达但假绿」。
 *
 * 两种形态：
 * - **domain**（自有域）：模块挂 `https://<domain>/m/<id>/`（zone 路径路由，§5.3 单域名路径制）；
 * - **workers.dev**（向导默认，零 DNS/zone 权限）：CF 为每个上传的 Worker 免费提供
 *   `https://<worker-name>.<account-subdomain>.workers.dev`——模块用自己的子域作为真实 URL。
 *   注意此形态下**没有** zone 路由：`/m/<id>/*` 只在配置了 domain 时才创建，
 *   拿 core 的 URL 拼 `/m/<id>` 会命中壳 SPA 回退（返回 HTML），冒烟必判红（#273 根因）。
 *
 * 「模块恒挂根路径」不变式（决策 #63）在两形态下都成立：workers.dev 形态模块就挂子域根，
 * 无需前缀剥除；domain 形态由宿主 wrapper 剥 `/m/<id>` 前缀。
 */

/** 模块挂载形态。 */
export type MountShape = 'domain' | 'workers-dev';

/** 模块 URL 决策输入（模块级，逐个模块调用）。 */
export interface ModuleUrlInput {
  /** 实例对外域名（`unself.config.jsonc` domain）；空串/空白 = workers.dev 形态。 */
  domain: string;
  /** workers.dev 账号子域（无 domain 时必填；由 resolveBaseUrl 解析）。 */
  workersDevSubdomain: string | null;
  /** 模块 id（domain 形态拼路由段）。 */
  moduleId: string;
  /** 模块 Worker 名（workers.dev 形态拼子域，含实例命名空间前缀）。 */
  moduleWorkerName: string;
}

/** 形态判定：domain 非空 = zone 路径制；否则 workers.dev 自有子域。 */
export function mountShapeOf(domain: string | null | undefined): MountShape {
  return domain && domain.trim() !== '' ? 'domain' : 'workers-dev';
}

/**
 * 模块真实挂载根 URL（**无**尾斜杠）——注册表 entry、冒烟 health、主题体检页面的共同基址。
 * workers.dev 形态缺账号子域 → 直接抛错：宁可停住，也不回落到 core URL 产生「不可达但看起来跑了」。
 */
export function moduleBaseUrl(input: ModuleUrlInput): string {
  if (mountShapeOf(input.domain) === 'domain') {
    return `https://${input.domain.trim()}/m/${input.moduleId}`;
  }
  if (!input.workersDevSubdomain) {
    throw new Error(
      `workers.dev 形态无法解析账号子域：模块 ${input.moduleId} 的真实 URL 拼不出来——` +
        '检查凭证对 GET /accounts/<id>/workers/subdomain 的权限，勿回落到 core URL',
    );
  }
  return `https://${input.moduleWorkerName}.${input.workersDevSubdomain}.workers.dev`;
}

/** 模块 entry（带尾斜杠；与契约 `entry` 字段一致，壳按此装载 iframe）。 */
export function moduleEntryUrl(input: ModuleUrlInput): string {
  return `${moduleBaseUrl(input)}/`;
}

/** 模块 zone 路由 pattern（仅 domain 形态使用；workers.dev 形态无 zone 路由）。 */
export function moduleRoutePattern(domain: string, moduleId: string): string {
  return `${domain}/m/${moduleId}/*`;
}

/**
 * 从 core 的 workers.dev URL 解析账号子域：
 * `https://<core-worker>.<sub>.workers.dev` → `<sub>`；形状不符（自有域 / 非 https / 名字不匹配）→ null。
 * 这样 moduleTargets 与 resolveBaseUrl 用的是同一次子域查询结果，不再二次请求 API。
 */
export function parseWorkersDevSubdomain(coreBaseUrl: string, coreWorkerName: string): string | null {
  let url: URL;
  try {
    url = new URL(coreBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const suffix = '.workers.dev';
  if (!url.hostname.endsWith(suffix)) return null;
  const rest = url.hostname.slice(0, -suffix.length);
  const prefix = `${coreWorkerName}.`;
  if (!rest.startsWith(prefix)) return null;
  const sub = rest.slice(prefix.length);
  return sub.length > 0 ? sub : null;
}

/** base URL 的 origin（模块页 frame-ancestors 的值 = 壳 origin，决策 #63）。 */
export function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/** 模块 health 探测 URL（根挂载不变式：`<moduleBaseUrl>/api/health`）。 */
export function moduleHealthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/health`;
}
