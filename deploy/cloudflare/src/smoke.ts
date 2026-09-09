// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 冒烟、setup token 与部署期主题体检（步骤⑧⑨，§5.5 / §6.5.8）：
 * ⑧ POST /api/admin/setup-token → 一次性激活链接打印在部署输出末尾（409 = 实例已封死）；
 * ⑨ GET /api/health + 各选中模块 /m/<id>/api/health（经实例域路径路由）；
 *    主题体检 = GET /m/<id>/ 模块页产物，查 --unself-* 引用是否全部在契约白名单（§6.5.8）。
 */
import { analyzeTokenUsage } from '@unself/contracts';

import type { Wrangler } from './wrangler';

export interface SmokeResult {
  name: string;
  url: string;
  ok: boolean;
  status: number;
  detail?: string;
}

/** 生成一次性 setup token（部署输出末尾打印；幂等：已封死拿 409 属预期）。 */
export async function fetchSetupToken(input: {
  baseUrl: string;
  log?: (msg: string) => void;
}): Promise<{ token: string; setupUrl: string } | { sealed: true }> {
  const log = input.log ?? console.log;
  let res: Response;
  try {
    res = await fetch(`${input.baseUrl}/api/admin/setup-token`, { method: 'POST' });
  } catch (err) {
    throw new Error(
      `无法访问 ${input.baseUrl}（fetch failed）。workers.dev 域名在本机网络可能不可达（DNS 污染/拦截）；` +
      `可用代理环境变量重试，或稍后在可直连的网络执行第⑧⑨步。原因：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 409) {
    log('setup 已完成（实例已封死激活入口）——跳过 token 打印');
    return { sealed: true };
  }
  if (!res.ok) {
    throw new Error(`setup token 获取失败（HTTP ${res.status}）`);
  }
  const body = (await res.json()) as { token: string; setupUrl: string };
  return { token: body.token, setupUrl: body.setupUrl };
}

/** 主题体检结果（§6.5.8）：模块页产物的 --unself-* 引用解析情况。 */
export interface ThemeCheckResult {
  name: string;
  url: string;
  ok: boolean;
  /** 零 --unself-* 引用 = 独立皮肤（§6.5.7 完全独立皮肤允许，标注不红）。 */
  skinned: boolean;
  /** 不在契约白名单的 var(--xxx)（平台永不提供值 → 未解析）。 */
  unknown: string[];
  detail?: string;
}

/**
 * 部署期主题体检（§6.5.8 验产物，不验源码）：抓各模块页根路径 HTML，
 * 查 var(--unself-*) 引用是否全部解析成契约值。未解析 = 平台链路坏了 → 当场红；
 * 模块零主题引用 = 独立皮肤 → 标注不红。每个页面只抓根路径、不解析客户端 JS；
 * 单页失败（不可达/超时）只记该页失败，整体不抛异常（结果收集）。
 */
export async function checkModuleThemes(input: {
  baseUrl: string;
  moduleIds: string[];
  timeoutMs?: number;
}): Promise<ThemeCheckResult[]> {
  const results: ThemeCheckResult[] = [];
  for (const id of input.moduleIds) {
    // 与用户实际加载相同的模块页根路径（除 SPA 路由外，模块文档由此进入）
    const url = `${input.baseUrl}/m/${id}/`;
    const name = `module:${id}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
      });
      if (!res.ok) {
        results.push({ name, url, ok: false, skinned: false, unknown: [], detail: `HTTP ${res.status}` });
        continue;
      }
      const text = await res.text();
      const { used, unknown } = analyzeTokenUsage(text);
      results.push({ name, url, ok: unknown.length === 0, skinned: used.length === 0, unknown });
    } catch (err) {
      results.push({
        name,
        url,
        ok: false,
        skinned: false,
        unknown: [],
        detail: `不可达：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}

/** 冒烟：core health + 各模块 health。§5.3 单域名路径制：domain 与 workers.dev 两种 baseUrl 同形，模块均探 <baseUrl>/m/<id>/api/health（无子域分支）。全部 200 且 ok=true 才算通过。 */
export async function smokeCheck(input: {
  baseUrl: string;
  moduleIds: string[];
  timeoutMs?: number;
}): Promise<SmokeResult[]> {
  const targets: Array<{ name: string; path: string }> = [
    { name: 'core-api', path: '/api/health' },
    ...input.moduleIds.map((id) => ({ name: `module:${id}`, path: `/m/${id}/api/health` })),
  ];
  const results: SmokeResult[] = [];
  for (const t of targets) {
    const url = `${input.baseUrl}${t.path}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
      });
      let ok = res.status === 200;
      let detail: string | undefined;
      if (ok) {
        const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        ok = body?.ok === true;
        if (!ok) detail = '响应体缺 ok:true';
      } else {
        detail = `HTTP ${res.status}`;
      }
      results.push({ name: t.name, url, ok, status: res.status, detail });
    } catch (err) {
      results.push({
        name: t.name,
        url,
        ok: false,
        status: 0,
        detail: `不可达：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}

/** Wrangler 探测当前 workers.dev 域名（config.domain 为空时步骤③部署完解析用）。 */
export function parseWorkersDevFromDeployOutput(stdout: string): string | null {
  const m = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i.exec(stdout);
  return m ? m[0] : null;
}

/** 供 fake 注入的最小执行接口别名（保持与 wrangler.ts 解耦）。 */
export type { Wrangler };
