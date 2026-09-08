// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 部署期 DNS 自愈（§5.3 zone 路径路由，B 方案 #59）：
 *
 * core 主域与模块全部走 zone 路径路由（Workers Routes），不用 Custom Domain——
 * 硬约束：同一 host 上 Custom Domain 优先于路径路由，core 挂 Custom Domain 会吞掉
 * 模块的 <domain>/m/<id>/*（真机实证，见 #59）。而 zone 路由要求 host 在 zone 内
 * 有 DNS 记录且被 Cloudflare 代理；Custom Domain 解绑时 CF 会删掉它自建的记录，
 * 本模块在 core 部署后补建一条代理 A 记录，保证主域持续可解析。
 *
 * 凭证：CLOUDFLARE_API_TOKEN（与 wrangler 同源），需 Zone: DNS Edit；zone 探测
 * 走逐级上溯（unself.demo.handywote.top → demo.handywote.top → handywote.top），
 * 不引入 config zone 字段（#59 待定案①按此定案）。
 */

interface DnsLog {
  (msg: string): void;
}

interface CfResult {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: unknown;
}

/** 空响应体视为 2xx 成功（CF 部分 API 返回 200/204 无 body），JSON 解析失败则按状态码判断。 */
async function toResult(res: Response): Promise<CfResult> {
  const text = await res.text();
  if (!text.trim()) return { success: res.ok };
  try {
    return (JSON.parse(text)) as CfResult;
  } catch {
    return { success: res.ok, errors: [{ code: 0, message: `非 JSON 响应：${text.slice(0, 80)}` }] };
  }
}

async function cfGet(url: string, token: string): Promise<CfResult> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return toResult(res);
}

async function cfDelete(url: string, token: string): Promise<CfResult> {
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  return toResult(res);
}

async function cfPost(url: string, token: string, body: unknown): Promise<CfResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as CfResult;
}

/** 首个可访问账户 id（部署脚本无需 config account 字段；token 多账户时取第一个）。 */
export async function findAccountId(token: string): Promise<string | null> {
  const res = await cfGet('https://api.cloudflare.com/client/v4/accounts', token);
  if (res.success && Array.isArray(res.result) && res.result.length > 0) {
    return (res.result[0] as { id: string }).id;
  }
  return null;
}

/**
 * 解绑遗留 Custom Domain（B 方案迁移：旧部署用 Custom Domain 挂过 core 主域与模块子域，
 * wrangler 配置改路由形态后不会自动解绑——同一 host 上 Custom Domain 优先于路径路由，
 * 不清理则模块路由永远被吞）。幂等：只删 hostname == domain 或 *.domain 的绑定。
 */
export async function removeLegacyCustomDomains(input: {
  accountId: string;
  domain: string;
  apiToken: string;
  log?: DnsLog;
}): Promise<void> {
  const { accountId, domain, apiToken, log = () => {} } = input;
  const res = await cfGet(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains`,
    apiToken,
  );
  if (!res.success) {
    log(`Custom Domain 列表查询失败：${JSON.stringify(res.errors)}`);
    return;
  }
  const list = (res.result ?? []) as Array<{ id: string; hostname: string }>;
  for (const item of list) {
    if (item.hostname === domain || item.hostname.endsWith(`.${domain}`)) {
      const del = await cfDelete(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains/${item.id}`,
        apiToken,
      );
      log(
        del.success
          ? `已解绑遗留 Custom Domain：${item.hostname}（CF 同步删其自建 DNS 记录）`
          : `Custom Domain 解绑失败 ${item.hostname}：${JSON.stringify(del.errors)}`,
      );
    }
  }
}

/** 逐级上溯找 domain 归属的 zone（无需 config zone 字段）。 */
export async function findZone(domain: string, token: string): Promise<{ id: string; name: string } | null> {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    const res = await cfGet(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(candidate)}&status=active`,
      token,
    );
    if (res.success && Array.isArray(res.result) && res.result.length > 0) {
      const zone = res.result[0] as { id: string; name: string };
      return { id: zone.id, name: zone.name };
    }
  }
  return null;
}

/**
 * 确保 config.domain 有一条代理 A 记录（幂等：已存在任何 A 记录即跳过）。
 * zone 可传入（部署脚本已探测，避免二次 API）；不传则内部逐级上溯。
 * 无 token 时仅记日志跳过（workers.dev 占位模式不设 domain，不会走到此处）。
 */
export async function ensureZoneRecord(input: {
  domain: string;
  apiToken?: string;
  zone?: { id: string; name: string };
  log?: DnsLog;
}): Promise<void> {
  const { domain, apiToken, log = () => {} } = input;
  if (!apiToken) {
    log('跳过 DNS 自建：未提供 CLOUDFLARE_API_TOKEN');
    return;
  }
  const zone = input.zone ?? (await findZone(domain, apiToken));
  if (!zone) {
    log(`跳过 DNS 自建：未找到 "${domain}" 归属的 zone（或 token 无该 zone 读权限）`);
    return;
  }
  const base = `https://api.cloudflare.com/client/v4/zones/${zone.id}`;
  const existing = await cfGet(
    `${base}/dns_records?type=A&name=${encodeURIComponent(domain)}`,
    apiToken,
  );
  if (existing.success && Array.isArray(existing.result) && existing.result.length > 0) {
    const rec = existing.result[0] as { content: string; proxied: boolean };
    log(`DNS 记录已存在（跳过）：${domain} → ${rec.content} proxied=${rec.proxied}`);
    return;
  }
  // 192.0.2.1：CF 文档推荐的代理占位地址——代理开启后流量由 zone 路由接管，不落该 IP
  const created = await cfPost(`${base}/dns_records`, apiToken, {
    type: 'A',
    name: domain,
    content: '192.0.2.1',
    proxied: true,
    ttl: 1,
  });
  if (!created.success) {
    log(`DNS 记录创建失败：${JSON.stringify(created.errors)}`);
    return;
  }
  log(`DNS 记录已创建：${domain} → 192.0.2.1（proxied，zone 路由接管）`);
}
