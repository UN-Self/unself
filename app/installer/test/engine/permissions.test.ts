// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 权限自检行为测试（#246）：注入 fetch 替身，不真打网络。
 * 红灯点：把探测结果改坏（缺项不报 / 非权限错误误拦 / 多级子域不提示 Total TLS）必红。
 */
import { describe, expect, it } from 'vitest';
import { CloudflareApiError, RestClient } from '../../src/engine/rest/client';
import { describePermissions, isPermissionError, probePermissions } from '../../src/engine/permissions';

/** 按路径前缀路由的 fetch 替身：记录请求序列。 */
function fakeFetch(routes: Array<{ match: (url: string) => boolean; status: number; body?: unknown }>) {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const r = routes.find((x) => x.match(url));
    const body = r?.body ?? { success: true, result: [], errors: [] };
    return new Response(JSON.stringify(body), { status: r?.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, impl };
}

const ACCOUNTS = { success: true, result: [{ id: 'acc-1', name: 'team' }], errors: [] };

function clientOf(impl: typeof fetch): RestClient {
  return new RestClient({ token: 't', fetchImpl: impl, retries: 0 });
}

describe('probePermissions 只读四探', () => {
  it('全部可读 → ok=true，逐项「能做哪些」；探测顺序 accounts→d1→r2→kv→zones', async () => {
    const f = fakeFetch([
      { match: (u) => u.includes('/accounts'), status: 200, body: ACCOUNTS },
      { match: (u) => u.includes('/d1/database'), status: 200 },
      { match: (u) => u.includes('/r2/buckets'), status: 200 },
      { match: (u) => u.includes('/storage/kv/namespaces'), status: 200 },
      { match: (u) => u.endsWith('/zones'), status: 200 },
    ]);
    const r = await probePermissions(clientOf(f.impl));
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.lines).toContain('✓ D1（列表）：可读');
    expect(r.lines).toContain('✓ R2（列表）：可读');
    expect(r.lines).toContain('✓ KV（列表）：可读');
    expect(r.lines).toContain('✓ zones（列表）：可读');
    expect(r.accountId).toBe('acc-1');
    expect(f.calls[0]).toContain('/accounts');
    expect(f.calls[1]).toContain('/d1/database');
    expect(f.calls[2]).toContain('/r2/buckets');
    expect(f.calls[3]).toContain('/storage/kv/namespaces');
    expect(f.calls[4]).toContain('/zones');
  });

  it('D1 403 → ok=false，缺项指名 D1 并给修复指引；其余项仍逐项报（红灯点：缺项不报必红）', async () => {
    const f = fakeFetch([
      { match: (u) => u.endsWith('/accounts'), status: 200, body: ACCOUNTS },
      { match: (u) => u.includes('/d1/database'), status: 403, body: { success: false, result: null, errors: [{ code: 9109, message: 'Unauthorized' }] } },
      { match: (u) => u.includes('/r2/buckets'), status: 200 },
      { match: (u) => u.includes('/storage/kv/namespaces'), status: 200 },
      { match: (u) => u.endsWith('/zones'), status: 200 },
    ]);
    const r = await probePermissions(clientOf(f.impl));
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]).toContain('D1');
    expect(r.missing[0]).toContain('D1 Edit');
    expect(r.lines.some((l) => l.startsWith('✓ R2'))).toBe(true);
  });

  it('网络错误（非权限）不误拦：折进 lines 的 ? 行，missing 为空（红灯点：把网络错误当缺项必红）', async () => {
    const f = fakeFetch([
      { match: (u) => u.endsWith('/accounts'), status: 200, body: ACCOUNTS },
      { match: (u) => u.includes('/r2/buckets'), status: 502, body: '<html>bad gateway</html>' },
      { match: (u) => u.includes('/storage/kv/namespaces'), status: 200 },
      { match: (u) => u.includes('/d1/database'), status: 200 },
      { match: (u) => u.endsWith('/zones'), status: 200 },
    ]);
    const r = await probePermissions(clientOf(f.impl));
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.lines.some((l) => l.startsWith('? R2'))).toBe(true);
  });

  it('凭证全坏（GET /accounts 403）→ 四项全部「无法探测」且缺项给重建指引', async () => {
    const f = fakeFetch([{ match: () => true, status: 403, body: { success: false, result: null, errors: [{ code: 9109, message: 'Unauthorized' }] } }]);
    const r = await probePermissions(clientOf(f.impl));
    expect(r.ok).toBe(false);
    expect(r.accountId).toBeNull();
    expect(r.missing).toHaveLength(5); // 账户 + 四项
    expect(r.missing[0]).toContain('账户列表');
  });

  it('多级子域（a.b.handywote.top ∈ handywote.top）→ Total TLS 预检进缺项（OAuth 唯一不可用项，开跑前说明）', async () => {
    const f = fakeFetch([
      { match: (u) => u.includes('/accounts'), status: 200, body: ACCOUNTS },
      { match: (u) => u.includes('/d1/database'), status: 200 },
      { match: (u) => u.includes('/r2/buckets'), status: 200 },
      { match: (u) => u.includes('/storage/kv/namespaces'), status: 200 },
      { match: (u) => u.endsWith('/zones'), status: 200, body: { success: true, result: [{ id: 'z1', name: 'handywote.top' }], errors: [] } },
    ]);
    const r = await probePermissions(clientOf(f.impl), { domain: 'a.b.handywote.top' });
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.includes('Total TLS'))).toBe(true);
  });

  it('一级子域（team.handywote.top）→ 不触发 Total TLS 预检', async () => {
    const f = fakeFetch([
      { match: (u) => u.includes('/accounts'), status: 200, body: ACCOUNTS },
      { match: (u) => u.includes('/d1/database'), status: 200 },
      { match: (u) => u.includes('/r2/buckets'), status: 200 },
      { match: (u) => u.includes('/storage/kv/namespaces'), status: 200 },
      { match: (u) => u.endsWith('/zones'), status: 200, body: { success: true, result: [{ id: 'z1', name: 'handywote.top' }], errors: [] } },
    ]);
    const r = await probePermissions(clientOf(f.impl), { domain: 'team.handywote.top' });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
});

describe('isPermissionError', () => {
  it('403 / 9107 / 9109 / 10000 判权限；5xx 与网络错误不判', () => {
    expect(isPermissionError(new CloudflareApiError('x', 9109, 403, []))).toBe(true);
    expect(isPermissionError(new CloudflareApiError('x', 0, 403, []))).toBe(true);
    expect(isPermissionError(new CloudflareApiError('x', 10000, 400, []))).toBe(true);
    expect(isPermissionError(new CloudflareApiError('x', 0, 502, []))).toBe(false);
    expect(isPermissionError(new Error('fetch failed'))).toBe(false);
  });
});

describe('describePermissions', () => {
  it('渲染：ok → 「通过」；缺项 → 数量 + 逐条指引', async () => {
    const f = fakeFetch([
      { match: (u) => u.endsWith('/accounts'), status: 200, body: ACCOUNTS },
      { match: () => true, status: 403, body: { success: false, result: null, errors: [{ code: 9109, message: 'Unauthorized' }] } },
    ]);
    const r = await probePermissions(clientOf(f.impl));
    const lines = describePermissions(r);
    expect(lines.join('\n')).toContain('缺 4 项');
    expect(lines.join('\n')).toContain('·');

    const ok = await probePermissions(clientOf(fakeFetch([{ match: (u) => u.endsWith('/accounts'), status: 200, body: ACCOUNTS }]).impl));
    expect(describePermissions(ok).join('\n')).toContain('权限自检通过');
  });
});
