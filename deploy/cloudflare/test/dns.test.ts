// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureTotalTls, ensureZoneRecord, findAccountId, findZone, removeLegacyCustomDomains, removeModuleRoutes } from '../src/dns';

/** 记录 fetch 请求并回放预设响应（按 URL 前缀匹配）。 */
function stubCf(routes: Array<{ match: RegExp; respond: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const hit = routes.find((r) => r.match.test(url));
    if (!hit) return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'unmatched' }] }), { status: 404 });
    return new Response(JSON.stringify(hit.respond), { status: 200 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('findZone（逐级上溯，不引入 config zone 字段）', () => {
  it('多级子域：上溯到真实 zone handywote.top', async () => {
    const calls = stubCf([
      { match: /name=unself\.demo\.handywote\.top/, respond: { success: true, result: [] } },
      { match: /name=demo\.handywote\.top/, respond: { success: true, result: [] } },
      { match: /name=handywote\.top/, respond: { success: true, result: [{ id: 'zone-1', name: 'handywote.top', status: 'active' }] } },
    ]);
    const zone = await findZone('unself.demo.handywote.top', 'tok');
    expect(zone).toEqual({ id: 'zone-1', name: 'handywote.top' });
    expect(calls).toHaveLength(3);
  });

  it('首级即命中：domain 本身就是 zone', async () => {
    stubCf([{ match: /name=handywote\.top/, respond: { success: true, result: [{ id: 'zone-1', name: 'handywote.top', status: 'active' }] } }]);
    const zone = await findZone('handywote.top', 'tok');
    expect(zone).toEqual({ id: 'zone-1', name: 'handywote.top' });
  });

  it('全链未命中 → null（不抛错，部署继续）', async () => {
    stubCf([{ match: /name=/, respond: { success: true, result: [] } }]);
    expect(await findZone('unself.demo.handywote.top', 'tok')).toBeNull();
  });
});

describe('findAccountId（部署脚本账户发现，不引入 config account 字段）', () => {
  it('取首个可访问账户', async () => {
    stubCf([{ match: /\/accounts$/, respond: { success: true, result: [{ id: 'acc-1', name: 'a' }] } }]);
    expect(await findAccountId('tok')).toBe('acc-1');
  });

  it('无可访问账户 → null', async () => {
    stubCf([{ match: /\/accounts$/, respond: { success: true, result: [] } }]);
    expect(await findAccountId('tok')).toBeNull();
  });
});

describe('removeLegacyCustomDomains（B 方案迁移：解绑同域遗留 Custom Domain）', () => {
  it('只删 domain 自身与 *.domain 的绑定，无关域不动', async () => {
    const calls = stubCf([
      {
        match: /workers\/domains$/,
        respond: {
          success: true,
          result: [
            { id: 'd1', hostname: 'demo.handywote.top' },
            { id: 'd2', hostname: 'hello.demo.handywote.top' },
            { id: 'd3', hostname: 'other.example.com' },
          ],
        },
      },
      { match: /workers\/domains\/d[12]$/, respond: { success: true, result: { id: 'x' } } },
    ]);
    const logs: string[] = [];
    await removeLegacyCustomDomains({
      accountId: 'acc-1',
      domain: 'demo.handywote.top',
      apiToken: 'tok',
      log: (m) => logs.push(m),
    });
    const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deleted).toHaveLength(2);
    expect(deleted.every((u) => u.includes('workers/domains/d1') || u.includes('workers/domains/d2'))).toBe(true);
    expect(logs.filter((l) => l.includes('已解绑'))).toHaveLength(2);
  });

  it('无匹配域 → 零删除', async () => {
    const calls = stubCf([
      {
        match: /workers\/domains$/,
        respond: { success: true, result: [{ id: 'd3', hostname: 'other.example.com' }] },
      },
    ]);
    await removeLegacyCustomDomains({ accountId: 'acc-1', domain: 'demo.handywote.top', apiToken: 'tok' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('DELETE 返回空 body（真机：200 无体）→ 仍计成功并记录日志', async () => {
    // stubCf 只能回放 JSON——这里直接手工 stub 空体响应
    const rawFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/workers/domains')) {
        return new Response(JSON.stringify({
          success: true,
          result: [{ id: 'd1', hostname: 'demo.handywote.top' }],
        }), { status: 200 });
      }
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 200 }); // 空体
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', rawFetch);
    const logs: string[] = [];
    await removeLegacyCustomDomains({
      accountId: 'acc-1',
      domain: 'demo.handywote.top',
      apiToken: 'tok',
      log: (m) => logs.push(m),
    });
    expect(logs.filter((l) => l.includes('已解绑'))).toHaveLength(1);
  });
});

describe('ensureTotalTls（多级子域证书覆盖，幂等）', () => {
  it('POST enabled:true 且成功日志', async () => {
    const calls = stubCf([{ match: /acm\/total_tls$/, respond: { success: true, result: { enabled: true } } }]);
    const logs: string[] = [];
    await ensureTotalTls({ zoneId: 'zone-1', apiToken: 'tok', log: (m) => logs.push(m) });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ enabled: true });
    expect(logs[0]).toContain('已开启');
  });

  it('无 SSL 权限 → 失败日志提示所需权限', async () => {
    stubCf([{ match: /acm\/total_tls$/, respond: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } }]);
    const logs: string[] = [];
    await ensureTotalTls({ zoneId: 'zone-1', apiToken: 'tok', log: (m) => logs.push(m) });
    expect(logs[0]).toContain('SSL and Certificates Edit');
  });
});

describe('ensureZoneRecord（幂等 DNS 自愈）', () => {
  it('无 token → 仅日志跳过', async () => {
    const logs: string[] = [];
    const calls = stubCf([]);
    await ensureZoneRecord({ domain: 'demo.handywote.top', apiToken: undefined, log: (m) => logs.push(m) });
    expect(calls).toHaveLength(0);
    expect(logs[0]).toContain('跳过');
  });

  it('zone 未找到 → 跳过并记录原因', async () => {
    stubCf([{ match: /name=/, respond: { success: true, result: [] } }]);
    const logs: string[] = [];
    await ensureZoneRecord({ domain: 'demo.handywote.top', apiToken: 'tok', log: (m) => logs.push(m) });
    expect(logs[0]).toContain('未找到');
  });

  it('记录已存在 → 跳过创建', async () => {
    const calls = stubCf([
      { match: /zones\?name=handywote\.top/, respond: { success: true, result: [{ id: 'zone-1', name: 'handywote.top' }] } },
      { match: /dns_records\?type=A&name=unself\.demo\.handywote\.top/, respond: { success: true, result: [{ content: '192.0.2.9', proxied: true }] } },
    ]);
    const logs: string[] = [];
    await ensureZoneRecord({ domain: 'unself.demo.handywote.top', apiToken: 'tok', log: (m) => logs.push(m) });
    expect(logs[0]).toContain('已存在');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('无记录 → 创建代理 A 占位记录（192.0.2.1, proxied, ttl=1）', async () => {
    const calls = stubCf([
      { match: /zones\?name=handywote\.top/, respond: { success: true, result: [{ id: 'zone-1', name: 'handywote.top' }] } },
      { match: /dns_records\?type=A/, respond: { success: true, result: [] } },
      { match: /dns_records$/, respond: { success: true, result: { id: 'rec-1' } } },
    ]);
    const logs: string[] = [];
    await ensureZoneRecord({ domain: 'unself.demo.handywote.top', apiToken: 'tok', log: (m) => logs.push(m) });
    const created = calls.find((c) => c.method === 'POST');
    expect(created?.url).toContain('/zones/zone-1/dns_records');
    expect(created?.body).toEqual({
      type: 'A',
      name: 'unself.demo.handywote.top',
      content: '192.0.2.1',
      proxied: true,
      ttl: 1,
    });
    expect(logs[0]).toContain('已创建');
  });
});

describe('removeModuleRoutes（未选模块路由删除，幂等）', () => {
  it('命中删除：只删 moduleIds 中模块的精确路由，其余路由不动', async () => {
    const calls = stubCf([
      {
        match: /workers\/routes$/,
        respond: {
          success: true,
          result: [
            { id: 'r-hello', pattern: 'demo.handywote.top/m/hello/*' },
            { id: 'r-chat', pattern: 'demo.handywote.top/m/chat/*' },
          ],
        },
      },
      { match: /workers\/routes\/r-hello$/, respond: { success: true, result: { id: 'r-hello' } } },
    ]);
    const logs: string[] = [];
    await removeModuleRoutes({
      zoneId: 'zone-1',
      domain: 'demo.handywote.top',
      moduleIds: ['hello'],
      apiToken: 'tok',
      log: (m) => logs.push(m),
    });
    const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain('/zones/zone-1/workers/routes/r-hello');
    expect(logs.filter((l) => l.includes('已删除'))).toHaveLength(1);
    expect(deleted.some((u) => u.includes('r-chat'))).toBe(false);
  });

  it('路由不存在（幂等）：零 DELETE，记「无需删除」日志', async () => {
    const calls = stubCf([{ match: /workers\/routes$/, respond: { success: true, result: [] } }]);
    const logs: string[] = [];
    await removeModuleRoutes({
      zoneId: 'zone-1',
      domain: 'demo.handywote.top',
      moduleIds: ['hello'],
      apiToken: 'tok',
      log: (m) => logs.push(m),
    });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(logs.some((l) => l.includes('无需删除'))).toBe(true);
  });

  it('空 moduleIds → 零 fetch', async () => {
    const calls = stubCf([]);
    await removeModuleRoutes({
      zoneId: 'zone-1',
      domain: 'demo.handywote.top',
      moduleIds: [],
      apiToken: 'tok',
    });
    expect(calls).toHaveLength(0);
  });

  it('zone 路由查询失败（success:false）→ 不抛错，记「查询失败」日志，零 DELETE', async () => {
    const calls = stubCf([
      { match: /workers\/routes$/, respond: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } },
    ]);
    const logs: string[] = [];
    await expect(
      removeModuleRoutes({
        zoneId: 'zone-1',
        domain: 'demo.handywote.top',
        moduleIds: ['hello', 'chat'],
        apiToken: 'tok',
        log: (m) => logs.push(m),
      }),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('查询失败'))).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('精确匹配不误删：相似 pattern（近似 id / 他域 / 无通配）均不动', async () => {
    const calls = stubCf([
      {
        match: /workers\/routes$/,
        respond: {
          success: true,
          result: [
            { id: 'r-1', pattern: 'demo.handywote.top/m/helloworld/*' },
            { id: 'r-2', pattern: 'other.example.com/m/hello/*' },
            { id: 'r-3', pattern: 'demo.handywote.top/m/hello' },
          ],
        },
      },
    ]);
    const logs: string[] = [];
    await removeModuleRoutes({
      zoneId: 'zone-1',
      domain: 'demo.handywote.top',
      moduleIds: ['hello'],
      apiToken: 'tok',
      log: (m) => logs.push(m),
    });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(logs.some((l) => l.includes('无需删除'))).toBe(true);
  });
});
