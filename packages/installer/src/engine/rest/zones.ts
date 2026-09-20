// SPDX-License-Identifier: AGPL-3.0-only
/**
 * zone REST（#65）：zone 逐级上溯 / DNS A 记录自愈 / Total TLS / zone 路由增删查（真机探针实测形状）。
 * 权限最小化：zone:read（探测）+ workers_routes:write（路由）+ dns:write（A 记录自愈）；
 * Total TLS 需 ssl_certs:write（OAuth 不覆盖 → 失败给人话跳过，不阻断部署）。
 */
import type { RestClient } from './client';

export interface Zone {
  id: string;
  name: string;
}

/** 逐级上溯找 domain 归属的 zone（unself.demo.handywote.top → demo → apex）。 */
export async function findZone(client: RestClient, domain: string): Promise<Zone | null> {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    const res = await client.get<Zone[]>(`/zones?name=${encodeURIComponent(candidate)}&status=active`);
    const zone = (res.result ?? [])[0];
    if (zone) return { id: zone.id, name: zone.name };
  }
  return null;
}

export interface RouteRow {
  id: string;
  pattern: string;
  script?: string;
}

export async function listRoutes(client: RestClient, zoneId: string): Promise<RouteRow[]> {
  const res = await client.get<RouteRow[]>(`/zones/${zoneId}/workers/routes`);
  return res.result ?? [];
}

/** 建路由（幂等：pattern 已存在且指向同一 script → 跳过；存在但 script 不同 → 更新）。 */
export async function ensureRoute(
  client: RestClient,
  zoneId: string,
  pattern: string,
  script: string,
  log: (m: string) => void,
): Promise<void> {
  const routes = await listRoutes(client, zoneId);
  const found = routes.find((r) => r.pattern === pattern);
  if (found) {
    if (found.script === script) {
      log(`zone 路由已存在：${pattern} → ${script}`);
      return;
    }
    await client.put<{ id: string }>(`/zones/${zoneId}/workers/routes/${found.id}`, { pattern, script });
    log(`zone 路由已更新：${pattern} → ${script}`);
    return;
  }
  await client.post(`/zones/${zoneId}/workers/routes`, { pattern, script });
  log(`zone 路由已创建：${pattern} → ${script}`);
}

export async function deleteRoute(client: RestClient, zoneId: string, routeId: string): Promise<void> {
  await client.delete(`/zones/${zoneId}/workers/routes/${routeId}`);
}

/** 删除未选模块的 zone 路由（幂等：不存在 → 无操作）。 */
export async function removeRoutesForPatterns(
  client: RestClient,
  zoneId: string,
  patterns: string[],
  log: (m: string) => void,
): Promise<void> {
  if (patterns.length === 0) return;
  const routes = await listRoutes(client, zoneId);
  for (const pattern of patterns) {
    const item = routes.find((r) => r.pattern === pattern);
    if (!item) {
      log(`路由不存在（无需删除）：${pattern}`);
      continue;
    }
    await deleteRoute(client, zoneId, item.id);
    log(`已删除路由 ${pattern}`);
  }
}

/** 确保代理 A 记录（幂等：已有任意 A 记录即跳过；192.0.2.1 为 CF 文档占位地址）。 */
export async function ensureZoneARecord(
  client: RestClient,
  zone: Zone,
  domain: string,
  log: (m: string) => void,
): Promise<void> {
  const res = await client.get<Array<{ id: string; content: string; proxied: boolean }>>(
    `/zones/${zone.id}/dns_records?type=A&name=${encodeURIComponent(domain)}`,
  );
  const existing = (res.result ?? [])[0];
  if (existing) {
    log(`DNS A 记录已存在（跳过）：${domain} → ${existing.content}`);
    return;
  }
  await client.post(`/zones/${zone.id}/dns_records`, {
    type: 'A',
    name: domain,
    content: '192.0.2.1',
    proxied: true,
    ttl: 1,
  });
  log(`DNS A 记录已创建：${domain} → 192.0.2.1（proxied）`);
}

/** 解绑 hostname 命中 domain 或 *.domain 的 Custom Domain（遗留迁移清理，幂等）。 */
export async function removeLegacyCustomDomains(
  client: RestClient,
  accountId: string,
  domain: string,
  log: (m: string) => void,
): Promise<void> {
  const res = await client.get<Array<{ id: string; hostname: string }>>(
    `/accounts/${accountId}/workers/domains`,
  );
  for (const item of res.result ?? []) {
    if (item.hostname === domain || item.hostname.endsWith(`.${domain}`)) {
      try {
        await client.delete(`/accounts/${accountId}/workers/domains/${item.id}`);
        log(`已解绑遗留 Custom Domain：${item.hostname}`);
      } catch (err) {
        log(`Custom Domain 解绑失败 ${item.hostname}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** Total TLS（多级子域证书）：OAuth 不覆盖 → 失败给人话跳过（决策 #66 兜底路径）。 */
export async function ensureTotalTls(
  client: RestClient,
  zoneId: string,
  log: (m: string) => void,
): Promise<void> {
  try {
    await client.post(`/zones/${zoneId}/acm/total_tls`, { enabled: true });
    log('Total TLS 已开启（多级子域证书逐个签发）');
  } catch (err) {
    log(`Total TLS 开启失败（需 API Token 的 ssl_certs:write，OAuth 不覆盖）：${err instanceof Error ? err.message : String(err)}`);
  }
}
