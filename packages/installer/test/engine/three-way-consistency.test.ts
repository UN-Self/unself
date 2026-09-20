// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 三方一致性红测（#59，§5.3 单域名路径制）：
 * 同一 config 下，「注册表 entry 装载点 == wrangler route 路由点 == 步骤⑨冒烟探测点」
 * 必须同 host 同路径前缀。任一条链漂移（子域式 custom domain、绝对 URL、前缀错位）即红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreWranglerConfig, moduleWranglerConfig } from '../../src/engine/assemble';
import { buildManifestSnapshot } from '../../src/engine/registry';
import { smokeCheck } from '../../src/engine/smoke';
import { moduleBaseUrl, moduleEntryUrl, moduleRoutePattern } from '../../src/engine/module-url';
import type { UnselfConfig } from '../../src/engine/config';

const DOMAIN = 'demo.handywote.top';
const CONFIG = {
  domain: DOMAIN,
  modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }],
  storage: { provider: 'r2', bucket: 'unself-storage' },
} as UnselfConfig;

const MANIFEST = 'id: hello\nruntimes:\n  - worker\nversion: 0.1.0\n';

/** 合法公钥 JWKS 字符串（模块 vars.CORE_JWKS_JSON 注入值；测试只关心路由三方一致，不做验签）。 */
const JWKS_JSON = JSON.stringify({
  keys: [{
    kty: 'EC',
    crv: 'P-256',
    x: '2zYTVcy0bDXQ7qqeNDB38zsPVvwUkKZ6-m3xA1zwA2U',
    y: 'j8zUPxAyGRUAaHRNYwdU3IW7TSBI1kSrg7RmUhb8lZk',
    kid: 'RDB_5KqpPvLCvU7V6n8r6-xxpSJutKJCWNmyZWesNSg',
    use: 'sig',
    alg: 'ES256',
  }],
});

/** 路由 pattern → 归一化 {host, prefix}：`demo.handywote.top/m/hello/*` → {demo.handywote.top, /m/hello/}。 */
function normalizeRoutePattern(pattern: string): { host: string; prefix: string } {
  const url = new URL(`https://${pattern.replace(/\*$/, '')}`);
  return { host: url.host, prefix: url.pathname };
}

describe('三方一致性（#59 §5.3：entry 装载点 == route 路由点 == smoke 探测点）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('domain 形态：模块 entry / zone 路由 pattern / 冒烟 URL 三者 host+前缀一致', async () => {
    const routeCfg = JSON.parse(moduleWranglerConfig({
      config: CONFIG,
      dbIds: { modules: 'modules-uuid' },
      mod: { id: 'hello' },
      jwksJson: JWKS_JSON,
      zoneName: 'handywote.top',
    })) as { routes: Array<{ pattern: string; custom_domain?: boolean; zone_name?: string }> };

    // 装载点 + 探测点用同一真值源（#273）：module-url 按形态算出模块挂载根
    const urlInput = {
      domain: DOMAIN,
      workersDevSubdomain: null,
      moduleId: 'hello',
      moduleWorkerName: 'unself-module-hello',
    };
    const entry = buildManifestSnapshot({
      manifestText: MANIFEST,
      moduleId: 'hello',
      baseUrl: `https://${DOMAIN}`,
      entry: moduleEntryUrl(urlInput),
    });

    const probed: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      probed.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const smoke = await smokeCheck({
      coreUrl: `https://${DOMAIN}`,
      modules: [{ id: 'hello', baseUrl: moduleBaseUrl(urlInput) }],
    });

    // 路由点：zone 路径路由（无 custom_domain 标记 = 不自动建 DNS/证书；zone_name 必填）
    expect(routeCfg.routes).toEqual([{ pattern: moduleRoutePattern(DOMAIN, 'hello'), zone_name: 'handywote.top' }]);

    const route = normalizeRoutePattern(routeCfg.routes[0]!.pattern);
    const entryUrl = new URL(entry.entry);
    const probe = new URL(smoke.find((r) => r.name === 'module:hello')!.url);

    expect({ host: entryUrl.host, prefix: entryUrl.pathname }).toEqual(route);
    expect({ host: probe.host, prefix: probe.pathname.slice(0, route.prefix.length) }).toEqual(route);
    expect(probed).toContain(`https://${DOMAIN}/m/hello/api/health`);
  });

  it('workers.dev 形态（#273）：entry == 冒烟探测 == 模块自有子域（无 zone 路由）', async () => {
    const urlInput = {
      domain: '',
      workersDevSubdomain: 'test-subdomain',
      moduleId: 'hello',
      moduleWorkerName: 'unself-module-hello',
    };
    const entry = buildManifestSnapshot({
      manifestText: MANIFEST,
      moduleId: 'hello',
      baseUrl: 'https://unself-core-api.test-subdomain.workers.dev',
      entry: moduleEntryUrl(urlInput),
    });
    expect(entry.entry).toBe('https://unself-module-hello.test-subdomain.workers.dev/');

    const probed: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      probed.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await smokeCheck({
      coreUrl: 'https://unself-core-api.test-subdomain.workers.dev',
      modules: [{ id: 'hello', baseUrl: moduleBaseUrl(urlInput) }],
    });
    // 探测点 == entry 装载点（同 origin，模块恒挂根路径）
    expect(probed).toContain('https://unself-module-hello.test-subdomain.workers.dev/api/health');
    // workers.dev 形态不生成 zone 路由（无 domain）：模块配置产物里没有 routes
    const cfg = JSON.parse(moduleWranglerConfig({
      config: { ...CONFIG, domain: '' },
      dbIds: { modules: 'modules-uuid' },
      mod: { id: 'hello' },
      jwksJson: JWKS_JSON,
    })) as { routes?: unknown };
    expect(cfg.routes).toBeUndefined();
  });

  it('core 与模块同走 zone 路径路由（同 host 上 Custom Domain 优先于路径路由，core 不挂）', () => {
    const core = JSON.parse(coreWranglerConfig({
      config: CONFIG,
      dbIds: { core: 'core-uuid', modules: 'modules-uuid' },
      coreName: 'unself-core-api',
      zoneName: 'handywote.top',
    })) as { routes: unknown };
    const mod = JSON.parse(moduleWranglerConfig({
      config: CONFIG,
      dbIds: { modules: 'modules-uuid' },
      mod: { id: 'hello' },
      jwksJson: JWKS_JSON,
      zoneName: 'handywote.top',
    })) as { routes: unknown };

    expect(core.routes).toEqual([{ pattern: `${DOMAIN}/*`, zone_name: 'handywote.top' }]);
    expect(mod.routes).toEqual([{ pattern: `${DOMAIN}/m/hello/*`, zone_name: 'handywote.top' }]);
  });
});
