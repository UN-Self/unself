// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 冒烟与 setup token（步骤⑧⑨，§5.5）：
 * ⑧ POST /api/admin/setup-token → 一次性激活链接打印在部署输出末尾（409 = 实例已封死）；
 * ⑨ GET /api/health + 各选中模块 /m/<id>/api/health（经实例域路径路由）。
 */
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

/** 冒烟：core health + 各模块 health。custom domain 模式下模块在 <id>.<域名>（子域式）；workers.dev 模式走主域路径路由 §5.3。全部 200 且 ok=true 才算通过。 */
export async function smokeCheck(input: {
  baseUrl: string;
  moduleIds: string[];
  timeoutMs?: number;
  /** custom domain 模式：模块 host = <id>.<baseUrl host> */
  moduleSubdomain?: boolean;
}): Promise<SmokeResult[]> {
  const host = input.baseUrl.replace(/^https?:\/\//, '');
  const targets: Array<{ name: string; path: string; base: string }> = [
    { name: 'core-api', path: '/api/health', base: input.baseUrl },
    ...input.moduleIds.map((id) => ({
      name: `module:${id}`,
      path: `/m/${id}/api/health`,
      base: input.moduleSubdomain ? `https://${id}.${host}` : input.baseUrl,
    })),
  ];
  const results: SmokeResult[] = [];
  for (const t of targets) {
    const url = `${t.base}${t.path}`;
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
