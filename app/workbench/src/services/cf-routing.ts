// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块「挂到哪」的 CF REST（#369）：Worker 环境的 fetch 版，与装配器同端点形状。
 *
 * 与装配器的关系：URL / 路由 pattern 的纯计算只有一份（`@unself/contracts/cf-routing`）；
 * 装配器的 REST 客户端（`app/installer/src/engine/rest/`）是 Node 侧包，Worker 不能 import，
 * 所以这里写 fetch 调用面。端点与装配器同源（#65 v4 信封）：
 * - `GET /zones?status=active` + 逐级上溯找 domain 的归属 zone；
 * - `GET/POST/PUT /zones/<id>/workers/routes`（幂等：同 pattern 同 script 跳过，不同则更新）；
 * - `GET /accounts/<id>/workers/subdomain` + `POST /accounts/<id>/workers/scripts/<name>/subdomain`。
 *
 * 凭证纪律（#165）：token 只在本模块的每次调用里出现，不落任何持久面；错误文案只带
 * 状态码与 CF 的 errors[].message，绝不含 token。
 */
import { moduleEntryUrl } from '@unself/contracts';

/** CF API 版本面（与 installer REST 客户端同源：v4）。 */
const CF_API = 'https://api.cloudflare.com/client/v4';

/** 挂载选择（install 请求体的 `mount` 字段；三种都是 direct 接入，区别只在地址怎么来）。
 * existing（#369）：管理员自己部署好的地址，连 moduleId 一起给（登记行不靠 package 清单）；
 * scriptName 对 existing 无意义（本文件不碰 CF）。
 */
export type ModuleMount =
  | { kind: 'zone'; domain: string }
  | { kind: 'workers-dev' }
  | { kind: 'existing'; moduleId: string; entry: string };

/** 人话错误（路由层转 400/502；CF 原始响应不整段回给前端）。 */
export class CfRoutingError extends Error {
  constructor(message: string, readonly status: 400 | 502) {
    super(message);
    this.name = 'CfRoutingError';
  }
}

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
}

/** v4 信封请求：非 2xx / success=false 一律转人话，错误文案不包含凭证。 */
async function cfRequest<T>(
  fetchImpl: typeof fetch,
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetchImpl(`${CF_API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
  if (!res.ok || !json || json.success === false) {
    const reason = json?.errors?.map((e) => e.message).filter(Boolean).join('；') || '无错误详情';
    throw new CfRoutingError(`CF API ${method} ${path} 失败（HTTP ${res.status}）：${reason}`, 502);
  }
  return json.result;
}

export interface AccountZone {
  id: string;
  name: string;
}

/** 账号下 active zone 清单（前端「挂到」下拉的数据源）。 */
export async function listAccountZones(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountZone[]> {
  const result = await cfRequest<Array<{ id: string; name: string }>>(
    fetchImpl,
    token,
    'GET',
    '/zones?status=active&per_page=50',
  );
  return (result ?? []).map((z) => ({ id: z.id, name: z.name }));
}

/** 逐级上溯找 domain 归属的 zone（`a.b.example.com` → `b.example.com` → `example.com`）。 */
export async function findZoneForDomain(
  token: string,
  domain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountZone | null> {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    const result = await cfRequest<AccountZone[]>(
      fetchImpl,
      token,
      'GET',
      `/zones?name=${encodeURIComponent(candidate)}&status=active`,
    );
    const zone = (result ?? [])[0];
    if (zone) return { id: zone.id, name: zone.name };
  }
  return null;
}

interface RouteRow {
  id: string;
  pattern: string;
  script?: string;
}

/** 建 zone 路由（幂等：pattern 已存在且指向同一 script → 跳过；存在但 script 不同 → 更新）。 */
export async function ensureWorkerRoute(
  token: string,
  zoneId: string,
  pattern: string,
  script: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const routes =
    (await cfRequest<RouteRow[]>(fetchImpl, token, 'GET', `/zones/${zoneId}/workers/routes`)) ?? [];
  const found = routes.find((r) => r.pattern === pattern);
  if (found) {
    if (found.script === script) return;
    await cfRequest(fetchImpl, token, 'PUT', `/zones/${zoneId}/workers/routes/${found.id}`, { pattern, script });
    return;
  }
  await cfRequest(fetchImpl, token, 'POST', `/zones/${zoneId}/workers/routes`, { pattern, script });
}

/** workers.dev 账号子域（没有这个子域就无法给脚本开通 workers.dev 访问）。 */
export async function accountWorkersDevSubdomain(
  token: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const result = await cfRequest<{ subdomain?: string }>(
    fetchImpl,
    token,
    'GET',
    `/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
  );
  return result?.subdomain ?? null;
}

/** 开通本脚本的 workers.dev 子域访问（幂等：重复开通同一脚本由 CF 侧收敛）。 */
export async function enableWorkerWorkersDev(
  token: string,
  accountId: string,
  scriptName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await cfRequest(
    fetchImpl,
    token,
    'POST',
    `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
    { enabled: true },
  );
}

/**
 * 挂载 → 注册表 entry。纯计算，实际 CF 副作用由调用方先做完：
 * - zone：`https://<domain>/m/<id>/`（路由 pattern 由 moduleRoutePattern 给）；
 * - workers-dev：`https://<scriptName>.<accountSubdomain>.workers.dev/`；
 * - existing：管理员自己给的地址（恒等回 entry；https 校验由 ModuleRegistrationSchema 兜底），
 *   moduleId/scriptName 只为统一签名而收，本分支不使用。
 */
export function mountEntryUrl(
  mount: ModuleMount,
  input: { moduleId: string; scriptName: string; workersDevSubdomain: string | null },
): string {
  if (mount.kind === 'existing') return mount.entry;
  if (mount.kind === 'zone') {
    return moduleEntryUrl({
      domain: mount.domain,
      workersDevSubdomain: null,
      moduleId: input.moduleId,
      moduleWorkerName: input.scriptName,
    });
  }
  return moduleEntryUrl({
    domain: '',
    workersDevSubdomain: input.workersDevSubdomain,
    moduleId: input.moduleId,
    moduleWorkerName: input.scriptName,
  });
}
