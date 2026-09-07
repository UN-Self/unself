// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { coreWranglerConfig, moduleWranglerConfig, prefixStripWrapperSource } from '../src/assemble';
import { coreWorkerEntrySource } from '../src/steps';
import type { UnselfConfig } from '../src/config';

describe('coreWranglerConfig（③生成的部署配置）', () => {
  const base = {
    config: {
      domain: 'team.example.com',
      modules: ['hello'],
      storage: { provider: 'r2', bucket: 'unself-storage' },
    } as UnselfConfig,
    dbIds: { core: 'core-uuid', modules: 'modules-uuid' },
    coreName: 'unself-core-api',
  };

  it('真实 database_id 回填 + SPA 资产 + run_worker_first API', () => {
    const cfg = JSON.parse(coreWranglerConfig(base)) as Record<string, unknown>;
    const d1 = (cfg as unknown as { d1_databases: Array<{ binding: string; database_id: string }> }).d1_databases;
    expect(d1).toHaveLength(2);
    expect(d1.find((d) => d.binding === 'CORE_DB')?.database_id).toBe('core-uuid');
    expect(d1.find((d) => d.binding === 'MODULES_DB')?.database_id).toBe('modules-uuid');
    const assets = (cfg as unknown as { assets: { not_found_handling: string; run_worker_first: string[] } }).assets;
    expect(assets.not_found_handling).toBe('single-page-application');
    expect(assets.run_worker_first).toContain('/api/*');
    expect((cfg as unknown as { routes: Array<{ pattern: string }> }).routes[0]?.pattern).toBe('team.example.com');
  });

  it('domain 空 → 无 routes（workers.dev 回退）', () => {
    const cfg = JSON.parse(coreWranglerConfig({ ...base, config: { ...base.config, domain: '' } })) as {
      routes?: unknown;
    };
    expect(cfg.routes).toBeUndefined();
  });

  it('同一输入生成字节级相同配置（确定性/幂等前提）', () => {
    expect(coreWranglerConfig(base)).toBe(coreWranglerConfig(base));
  });
});

describe('moduleWranglerConfig（④生成的部署配置）', () => {
  const input = {
    config: {
      domain: 'team.example.com',
      modules: ['hello'],
      storage: { provider: 'r2', bucket: 'b' },
    } as UnselfConfig,
    dbIds: { modules: 'modules-uuid' },
    mod: { id: 'hello' },
    jwksPath: '/.well-known/jwks.json',
  };

  it('route 绑定 /m/<id>/* + MODULES_DB 真实 id + CORE_JWKS_URL 绝对地址', () => {
    const cfg = JSON.parse(moduleWranglerConfig(input)) as {
      routes: Array<{ pattern: string }>;
      d1_databases: Array<{ binding: string; database_id: string }>;
      vars: { CORE_JWKS_URL: string; MODULE_ID: string };
    };
    expect(cfg.routes[0]?.pattern).toBe('team.example.com/m/hello/*');
    expect(cfg.d1_databases[0]?.database_id).toBe('modules-uuid');
    expect(cfg.vars.CORE_JWKS_URL).toBe('https://team.example.com/.well-known/jwks.json');
    expect(cfg.vars.MODULE_ID).toBe('hello');
  });
});

describe('prefixStripWrapperSource（④挂载前缀剥除）', () => {
  it('wrapper 剥 /m/<id> 前缀并保留 API 透传', () => {
    const src = prefixStripWrapperSource('hello');
    expect(src).toContain("const PREFIX = '/m/hello'");
    expect(src).toContain("url.pathname = url.pathname.slice(PREFIX.length)");
    expect(src).toContain("import worker from './worker.js'");
  });
});

describe('coreWorkerEntrySource', () => {
  it('入口 re-export core-api app（相对路径到 services）', () => {
    const src = coreWorkerEntrySource();
    expect(src).toContain("from '../../../services/core-api/src/index.ts'");
    expect(src).toContain('SPDX-License-Identifier');
  });
});
