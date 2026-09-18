// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 冒烟与部署期主题体检（步骤⑨，§5.5 / §6.5.8；#244 后步骤⑧的 setup token 走 ControlPlane）：
 * ⑨ GET /api/health + 各选中模块 /m/<id>/api/health（经实例域路径路由）；
 *    主题体检 = GET /m/<id>/ 模块页产物，查 --unself-* 引用是否全部在契约白名单（§6.5.8）。
 */
import { analyzeTokenUsage } from '@unself/contracts';

export interface SmokeResult {
  name: string;
  url: string;
  ok: boolean;
  status: number;
  detail?: string;
}

/** setup token 随机长度（字节）；形状与 services/core-api/src/setup.ts 对齐（24B → base64url 无填充）。 */
const SETUP_TOKEN_BYTES = 24;

/** 本地生成一次性 setup token（#165 方案 B：签发在装配器，不再有公开签发端点）。 */
export function generateSetupToken(): string {
  const buf = new Uint8Array(SETUP_TOKEN_BYTES);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

/**
 * 冒烟：core health + 各模块 health。§5.3 单域名路径制：domain 与 workers.dev 两种 baseUrl 同形，
 * 模块均探 <baseUrl>/m/<id>/api/health（无子域分支）。全部 200 且 ok=true 才算通过。
 */
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


/**
 * connect（external）模块可达性体检（决策 #63，issue #247）：
 * 复用冒烟语义逐个探用户填的 publicUrl（模块恒挂根路径：探 <publicUrl>/api/health，
 * 无前缀重写）。**诚实标注（硬要求）**：体检从安装器/部署机发出，只证明
 * 「安装器可达」——不证明用户浏览器可达（用户侧可能有内网 DNS / 代理 / 证书信任差异）。
 * 每条结果带 notice 字段承载该口径；汇总行由调用方（steps ⑨ 或文档）原样输出。
 */
export interface ConnectReachabilityResult {
  moduleId: string;
  url: string;
  ok: boolean;
  status: number;
  /** 诚实标注：本体检的能力边界（成功与失败都带）。 */
  notice: string;
  detail?: string;
}

/** 诚实标注文案（单一出处；测试断言它永不消失）。 */
export const CONNECT_REACHABILITY_NOTICE =
  '此体检只证明安装器可达，不证明用户浏览器可达（DNS/代理/证书信任可能因人而异）';

/**
 * 逐个探 external 模块的 publicUrl 健康端点。
 * 输入形状与 steps ⑨ 的模块清单解耦：调用方从注册表/配置取 (id, publicUrl) 喂入。
 * 单个失败只记该条，不抛（与 smokeCheck 同口径：结果收集，整体判定归调用方）。
 */
export async function checkConnectReachability(input: {
  /** external 模块清单：id + 用户填的 publicUrl（https 强制已在注册面校验）。 */
  modules: Array<{ id: string; publicUrl: string }>;
  timeoutMs?: number;
}): Promise<ConnectReachabilityResult[]> {
  const results: ConnectReachabilityResult[] = [];
  for (const mod of input.modules) {
    const url = `${mod.publicUrl.replace(/\/+$/, '')}/api/health`;
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
      results.push({ moduleId: mod.id, url, ok, status: res.status, notice: CONNECT_REACHABILITY_NOTICE, detail });
    } catch (err) {
      results.push({
        moduleId: mod.id,
        url,
        ok: false,
        status: 0,
        notice: CONNECT_REACHABILITY_NOTICE,
        detail: `不可达：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}
