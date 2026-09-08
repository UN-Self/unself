// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 三方一致性红测（#59，§5.3 单域名路径制）：
 * 同一 config 下，「注册表 entry 装载点 == wrangler route 路由点 == 步骤⑨冒烟探测点」
 * 必须同 host 同路径前缀。任一条链漂移（子域式 custom domain、绝对 URL、前缀错位）即红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreWranglerConfig, moduleWranglerConfig } from '../src/assemble';
import { buildManifestSnapshot } from '../src/registry';
import { smokeCheck } from '../src/smoke';
import type { UnselfConfig } from '../src/config';

const DOMAIN = 'demo.handywote.top';
const CONFIG = {
  domain: DOMAIN,
  modules: ['hello'],
  storage: { provider: 'r2', bucket: 'unself-storage' },
} as UnselfConfig;

const MANIFEST = 'id: hello\nversion: 0.1.0\n';

/** 路由 pattern → 归一化 {host, prefix}：`demo.handywote.top/m/hello/*` → {demo.handywote.top, /m/hello/}。 */
function normalizeRoutePattern(pattern: string): { host: string; prefix: string } {
  const url = new URL(`https://${pattern.replace(/\*$/, '')}`);
  return { host: url.host, prefix: url.pathname };
}

describe('三方一致性（#59 §5.3：entry 装载点 == route 路由点 == smoke 探测点）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('同一 config：模块 entry / zone 路由 pattern / 冒烟 URL 三者 host+前缀一致', async () => {
    const routeCfg = JSON.parse(moduleWranglerConfig({
      config: CONFIG,
      dbIds: { modules: 'modules-uuid' },
      mod: { id: 'hello' },
      jwksPath: '/.well-known/jwks.json',
    })) as { routes: Array<{ pattern: string; custom_domain?: boolean }> };

    // 装载点：步骤⑤写入注册表的 manifest.entry（壳按此装载 iframe）
    const entry = buildManifestSnapshot({ manifestText: MANIFEST, moduleId: 'hello', baseUrl: `https://${DOMAIN}` });

    // 探测点：步骤⑨真实 smokeCheck，仅 stub 网络层
    const probed: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      probed.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const smoke = await smokeCheck({ baseUrl: `https://${DOMAIN}`, moduleIds: ['hello'] });

    // 路由点：zone 路径路由（无 custom_domain 标记 = 不自动建 DNS/证书）
    expect(routeCfg.routes).toEqual([{ pattern: `${DOMAIN}/m/hello/*` }]);

    const route = normalizeRoutePattern(routeCfg.routes[0]!.pattern);
    const entryUrl = new URL(entry.entry);
    const probe = new URL(smoke.find((r) => r.name === 'module:hello')!.url);

    expect({ host: entryUrl.host, prefix: entryUrl.pathname }).toEqual(route);
    expect({ host: probe.host, prefix: probe.pathname.slice(0, route.prefix.length) }).toEqual(route);
    expect(probed).toContain(`https://${DOMAIN}/m/hello/api/health`);
  });

  it('core 与模块同走 zone 路径路由（同 host 上 Custom Domain 优先于路径路由，core 不挂）', () => {
    const core = JSON.parse(coreWranglerConfig({
      config: CONFIG,
      dbIds: { core: 'core-uuid', modules: 'modules-uuid' },
      coreName: 'unself-core-api',
    })) as { routes: unknown };
    const mod = JSON.parse(moduleWranglerConfig({
      config: CONFIG,
      dbIds: { modules: 'modules-uuid' },
      mod: { id: 'hello' },
      jwksPath: '/.well-known/jwks.json',
    })) as { routes: unknown };

    expect(core.routes).toEqual([{ pattern: `${DOMAIN}/*` }]);
    expect(mod.routes).toEqual([{ pattern: `${DOMAIN}/m/hello/*` }]);
  });
});
