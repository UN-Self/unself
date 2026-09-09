// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildModuleSdkAssets, coreWranglerConfig, moduleWranglerConfig, prefixStripWrapperSource, provisionAll } from '../src/assemble';
import { migrationWranglerConfig } from '../src/assemble';
import { coreWorkerEntrySource } from '../src/steps';
import type { UnselfConfig } from '../src/config';
import type { Wrangler } from '../src/wrangler';

/** 仓库根（测试进程从 deploy/cloudflare/test 起算）。 */
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;

describe('coreWranglerConfig（③生成的部署配置）', () => {
  const base = {
    config: {
      domain: 'team.example.com',
      modules: ['hello'],
      storage: { provider: 'r2', bucket: 'unself-storage' },
    } as UnselfConfig,
    dbIds: { core: 'core-uuid', modules: 'modules-uuid' },
    coreName: 'unself-core-api',
    zoneName: 'example.com',
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
    expect(cfg.routes).toEqual([{ pattern: 'team.example.com/*', zone_name: 'example.com' }]);
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

/** 合法公钥 JWKS（真实 P-256 公钥 JWK 形状的静态夹具，与 core GET /.well-known/jwks.json 同形）。 */
const JWKS_FIXTURE = JSON.stringify({
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

describe('moduleWranglerConfig（④生成的部署配置）', () => {
  const input = {
    config: {
      domain: 'team.example.com',
      modules: ['hello'],
      storage: { provider: 'r2', bucket: 'b' },
    } as UnselfConfig,
    dbIds: { modules: 'modules-uuid' },
    mod: { id: 'hello' },
    jwksJson: JWKS_FIXTURE,
    zoneName: 'example.com',
  };

  it('route 绑定 zone 路径 <domain>/m/<id>/*（无 custom_domain）+ MODULES_DB 真实 id + CORE_JWKS_JSON 完整 JWKS', () => {
    const cfg = JSON.parse(moduleWranglerConfig(input)) as {
      routes: Array<{ pattern: string; custom_domain?: boolean }>;
      d1_databases: Array<{ binding: string; database_id: string }>;
      vars: { MODULE_ID: string; CORE_JWKS_JSON: string; CORE_JWKS_URL?: string };
    };
    // 整对象断言：zone 路径 pattern 且无 custom_domain 键（Custom Domain 子域形态已废弃）
    expect(cfg.routes).toEqual([{ pattern: 'team.example.com/m/hello/*', zone_name: 'example.com' }]);
    expect(cfg.d1_databases[0]?.database_id).toBe('modules-uuid');
    expect(cfg.vars.MODULE_ID).toBe('hello');
    // vars：仅注入的 JWKS JSON 字符串，无运行时 JWKS URL（#71 根因①：模块零运行时网络取钥）
    expect(cfg.vars.CORE_JWKS_URL).toBeUndefined();
    expect(cfg.vars.CORE_JWKS_JSON).toBe(JWKS_FIXTURE);
    const jwks = JSON.parse(cfg.vars.CORE_JWKS_JSON) as { keys: Array<Record<string, string>> };
    expect(Array.isArray(jwks.keys)).toBe(true);
    const key = jwks.keys[0]!;
    expect(key.kty).toBe('EC');
    expect(key.crv).toBe('P-256');
    expect(key.x!.length).toBeGreaterThan(0);
    expect(key.y!.length).toBeGreaterThan(0);
    expect(key.kid!.length).toBeGreaterThan(0);
    expect(key.use).toBe('sig');
    expect(key.alg).toBe('ES256');
  });

  it('domain 空 → 无 routes（workers.dev 回退）', () => {
    const cfg = JSON.parse(moduleWranglerConfig({
      ...input,
      config: { ...input.config, domain: '' },
    })) as { routes?: unknown };
    expect(cfg.routes).toBeUndefined();
  });

  it('同一输入生成字节级相同配置（确定性/幂等前提）', () => {
    expect(moduleWranglerConfig(input)).toBe(moduleWranglerConfig(input));
  });
});

describe('prefixStripWrapperSource（④挂载前缀剥除）', () => {
  it('wrapper 剥 /m/<id> 前缀并保留 API 透传', () => {
    const src = prefixStripWrapperSource('hello');
    expect(src).toContain("const PREFIX = '/m/hello'");
    expect(src).toContain("url.pathname = url.pathname.slice(PREFIX.length)");
    expect(src).toContain("import worker from './app.js'");
  });
});

describe('migrationWranglerConfig（②迁移专用最小配置）', () => {
  it('真实 database_id + binding + 相对 migrations_dir，字段原样内嵌', () => {
    const cfg = JSON.parse(migrationWranglerConfig({
      binding: 'CORE_DB',
      databaseName: 'unself-core',
      databaseId: 'cfe45429-f564-46c5-87bb-2b3dc5e95a1e',
      migrationsDir: '../../../services/core-api/migrations/core',
    })) as { d1_databases: Array<{ binding: string; database_name: string; database_id: string; migrations_dir: string }> };
    expect(cfg.d1_databases[0]).toMatchObject({
      binding: 'CORE_DB',
      database_name: 'unself-core',
      database_id: 'cfe45429-f564-46c5-87bb-2b3dc5e95a1e',
      migrations_dir: '../../../services/core-api/migrations/core',
    });
  });
});

describe('coreWorkerEntrySource', () => {
  it('入口 re-export core-api app（相对路径到 services）', () => {
    const src = coreWorkerEntrySource('/repo/.deploy/cloudflare', '/repo');
    expect(src).toContain("from '../../services/core-api/src/index.ts'");
    expect(src).toContain('SPDX-License-Identifier');
  });
});

describe('buildModuleSdkAssets（T3 页面 SDK 装载契约）', () => {
  it('ESM 产物可具名 import；IIFE 产物无顶层 export（页面引 .js 即 SyntaxError）', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unself-sdk-assets-'));
    try {
      await buildModuleSdkAssets(join(REPO_ROOT, 'packages/module-sdk/src/index.ts'), dir);

      const esmPath = join(dir, 'module-sdk.esm.js');
      const esm = await readFile(esmPath, 'utf8');
      const iife = await readFile(join(dir, 'module-sdk.js'), 'utf8');
      expect(/^export\b/m.test(esm)).toBe(true);
      expect(/^export\b/m.test(iife)).toBe(false);

      // 行为断言：ESM 产物真实可 import，且暴露页面用到的具名符号
      const mod = (await import(pathToFileURL(esmPath).href)) as Record<string, unknown>;
      expect(typeof mod.createModuleSDK).toBe('function');
      expect(Object.keys(mod).sort()).toEqual([
        'createD1Storage',
        'createModuleSDK',
        'decodeJwtPayload',
        // #91 通道 B：主题语义名 → CSS 变量名单点转换（模块作者写样式用）
        'tokenCssName',
        'verifyModuleToken',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hello 页面 import 的资产名 == 装配生成的 ESM 资产名', async () => {
    const page = await readFile(join(REPO_ROOT, 'modules/hello/src/index.ts'), 'utf8');
    const specifier = /from '\.\/sdk\/([^']+)'/.exec(page)?.[1];
    expect(specifier).toBe('module-sdk.esm.js');
  });
});

describe('provisionAll（③ shell 每次部署重建，#73）', () => {
  it('dist 已存在也强制重建：新产物入 assets/shell，陈旧标记与旧内容不残留', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'unself-provision-'));
    try {
      // 预置陈旧 dist（模拟上次部署残留：过期产物 + 陈旧标记）
      const staleDist = join(rootDir, 'apps/shell/dist');
      await mkdir(join(staleDist, 'assets'), { recursive: true });
      await writeFile(join(staleDist, 'stale.marker'), 'stale');
      await writeFile(join(staleDist, 'index.html'), '<html><body>OLD BUILD</body></html>');
      await writeFile(join(staleDist, 'assets/index-OLD.js'), 'console.log("old")');

      // fake 构建：模拟真实重建——清空 dist 后写当前源码产物（删陈旧标记）
      let buildCalled = false;
      const buildShell = async (dir: string) => {
        expect(dir).toBe(rootDir);
        buildCalled = true;
        await rm(staleDist, { recursive: true, force: true });
        await mkdir(join(staleDist, 'assets'), { recursive: true });
        await writeFile(join(staleDist, 'index.html'), '<html><body>NEW BUILD</body></html>');
        await writeFile(join(staleDist, 'assets/index-NEW.js'), 'console.log("new")');
      };

      const provisioned = await provisionAll({
        rootDir,
        // 最小合法配置（类型断言沿用本文件现有风格）；modules 传空数组：跳过 esbuild，聚焦 shell 重建
        config: { domain: '', modules: ['hello'], storage: { provider: 'r2', bucket: 'unself-storage' } } as UnselfConfig,
        modules: [],
        dbIds: { core: 'core-uuid', modules: 'modules-uuid' },
        keypair: { existing: true },
        wrangler: {} as unknown as Wrangler,
        log: () => {},
        buildShell,
      });

      // dist 已存在但构建仍被调用 → 旧产物被真实重建覆盖
      expect(buildCalled).toBe(true);
      const shellAssets = join(rootDir, '.deploy/cloudflare/assets/shell');
      // 新产物已搬运进部署目录
      expect(await readFile(join(shellAssets, 'index.html'), 'utf8')).toContain('NEW BUILD');
      expect(await readFile(join(shellAssets, 'assets/index-NEW.js'), 'utf8')).toBe('console.log("new")');
      // 陈旧残留零容忍：标记与旧资产/旧内容不得出现
      expect(existsSync(join(shellAssets, 'stale.marker'))).toBe(false);
      expect(existsSync(join(shellAssets, 'assets/index-OLD.js'))).toBe(false);
      expect(await readFile(join(shellAssets, 'index.html'), 'utf8')).not.toContain('OLD BUILD');
      // 返回契约未破坏（outDir 落位 .deploy/cloudflare）
      expect(provisioned.outDir).toBe(join(rootDir, '.deploy/cloudflare'));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
