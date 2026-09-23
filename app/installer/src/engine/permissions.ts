// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 权限自检（issue #246 / 决策 #66）：开跑前对 D1 / R2 / KV / zones 各做一次**只读**探测，
 * 先告诉用户「你的凭证能做哪些、缺哪些」——权限不足在开跑前就报出缺项，不跑一半才炸。
 * 探测全部只读端点；判断依据是实测（issue #241）：
 * OAuth 覆盖 D1/R2/KV/zone 路由，仅 Total TLS 不可用；从 scope 清单推断权限不可靠，只能实测。
 * 禁令：日志只记「能力/缺项」，不打印 token。
 */
import { CloudflareApiError, findAccountId } from './rest/client';
import type { RestClient } from './rest/client';
import { needsTotalTls } from './steps';

/** 单项探测结论。 */
export type ProbeVerdict = 'ok' | 'denied' | 'error';

export interface PermissionProbeResult {
  /** 全部必需项 ok（无 denied）→ true。 */
  ok: boolean;
  /** 缺项人话（可直接贴给用户；含修复指引）。 */
  missing: string[];
  /** 报告行（逐项「能做哪些」）。 */
  lines: string[];
  /** 探测中解析到的账户 id（后续装配可复用）。 */
  accountId: string | null;
}

/** 单项定义：名称 + 只读端点 + 人话修复指引。 */
interface ProbeItem {
  key: 'd1' | 'r2' | 'kv' | 'zones';
  label: string;
  run: (client: RestClient, accountId: string) => Promise<unknown>;
  fix: string;
}

/** 权限错误判定：CF 权限类错误码（9107 未授权给 token / 9109 未授权访问资源 / 10000 认证错误）或 HTTP 403。 */
export function isPermissionError(err: unknown): boolean {
  if (err instanceof CloudflareApiError) {
    return err.status === 403 || err.code === 9107 || err.code === 9109 || err.code === 10000;
  }
  return false;
}

const ITEMS: ProbeItem[] = [
  {
    key: 'd1',
    label: 'D1（列表）',
    run: (c, acc) => c.get(`/accounts/${acc}/d1/database`),
    fix: '缺 Account 级 D1 权限（Workers → D1 Edit）：按向导深链接重建 token 或 `wrangler login` 重授权',
  },
  {
    key: 'r2',
    label: 'R2（列表）',
    run: (c, acc) => c.get(`/accounts/${acc}/r2/buckets`),
    fix: '缺 Account 级 R2 权限（Workers R2 Storage Edit）：深链接重建 token（实测 OAuth 可建桶，但机制未查明可能随上游漂移）',
  },
  {
    key: 'kv',
    label: 'KV（列表）',
    run: (c, acc) => c.get(`/accounts/${acc}/storage/kv/namespaces`),
    fix: '缺 Account 级 KV 权限（Workers KV Storage Edit）：深链接重建 token 或 `wrangler login` 重授权',
  },
  {
    key: 'zones',
    label: 'zones（列表）',
    run: (c) => c.get<Array<{ id: string; name: string }>>('/zones'),
    fix: '缺 Zone 级 Zone Read 权限（自有域名路由必需）：深链接重建 token 或 `wrangler login` 重授权',
  },
];

/**
 * 只读四探：accounts → d1 → r2 → kv → zones（依赖 accountId）。
 * 不抛——权限/网络问题都折进 result（missing/lines），由调用方决定是否终止开跑。
 */
export async function probePermissions(client: RestClient, opts: { domain?: string } = {}): Promise<PermissionProbeResult> {
  const lines: string[] = [];
  const missing: string[] = [];

  // 前置：账户定位（GET /accounts）
  let accountId: string | null = null;
  try {
    accountId = await findAccountId(client);
    lines.push('✓ 账户：可见（GET /accounts）');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`✗ 账户：不可读（${msg.slice(0, 160)}）`);
    missing.push('账户列表（GET /accounts）不可读：凭证无效或没有账户授权——重建 token / 重授权');
  }

  for (const item of ITEMS) {
    if (!accountId) {
      missing.push(`${item.label}：无法探测（账户不可读）`);
      continue;
    }
    try {
      await item.run(client, accountId);
      lines.push(`✓ ${item.label}：可读`);
    } catch (err) {
      if (isPermissionError(err)) {
        lines.push(`✗ ${item.label}：权限不足`);
        missing.push(`${item.label}权限不足——${item.fix}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        lines.push(`? ${item.label}：探测失败（${msg.slice(0, 120)}）——非权限问题，继续开跑，用到时再给人话`);
      }
    }
  }

  // Total TLS 预检（决策 #66：OAuth 唯一不可用项）：多级子域需要 API Token，开跑前就说明
  const domain = opts.domain;
  if (domain && accountId) {
    try {
      const zones = await client.get<Array<{ id: string; name: string }>>('/zones');
      const zone = zones.result.find((z) => domain === z.name || domain.endsWith(`.${z.name}`));
      if (zone && needsTotalTls(domain, zone.name)) {
        lines.push(`✗ Total TLS：${domain} 为多级子域（zone ${zone.name}），Universal SSL 不覆盖`);
        missing.push(
          `Total TLS 权限不足（实测 wrangler 4.129.0 OAuth 对 Total TLS 不可用，仅 API Token 可开）——${domain} 需要它；否则改用一级子域`,
        );
      }
    } catch {
      // zones 读不了已在上面报过；这里不重复
    }
  }

  return { ok: missing.length === 0, missing, lines, accountId };
}

/** 权限报告渲染（「先告诉用户能做哪些」）。 */
export function describePermissions(r: PermissionProbeResult): string[] {
  const out = [...r.lines];
  if (r.ok) {
    out.push('权限自检通过：以上能力足够装配。');
  } else {
    out.push(`权限自检未通过，缺 ${r.missing.length} 项（开跑前拦下）：`);
    for (const m of r.missing) out.push(`  · ${m}`);
  }
  return out;
}
