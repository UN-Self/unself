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

async function cfGet(url: string, token: string): Promise<CfResult> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()) as CfResult;
}

async function cfPost(url: string, token: string, body: unknown): Promise<CfResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as CfResult;
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
 * 无 token 时仅记日志跳过（workers.dev 占位模式不设 domain，不会走到此处）。
 */
export async function ensureZoneRecord(input: {
  domain: string;
  apiToken?: string;
  log?: DnsLog;
}): Promise<void> {
  const { domain, apiToken, log = () => {} } = input;
  if (!apiToken) {
    log('跳过 DNS 自建：未提供 CLOUDFLARE_API_TOKEN');
    return;
  }
  const zone = await findZone(domain, apiToken);
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
