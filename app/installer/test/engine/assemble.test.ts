// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { copySdkAssets, coreWranglerConfig, moduleWranglerConfig, prefixStripWrapperSource, provisionAll } from '../../src/engine/assemble';
import { migrationWranglerConfig } from '../../src/engine/assemble';
import { resolvePlatformArtifacts } from '../../src/engine/artifacts';
import type { UnselfConfig } from '../../src/engine/config';
import { findRepoRoot } from '../helpers/repo-root';
import { writeWorkbenchFixture } from './helpers/workbench-fixture';

/** 仓库根（测试进程从 app/installer/test/engine 起算）。 */
const REPO_ROOT = findRepoRoot();

describe('coreWranglerConfig（③生成的部署配置）', () => {
  const base = {
    config: {
      domain: 'team.example.com',
      modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }],
      storage: { provider: 'r2', bucket: 'unself-storage' },
    } as UnselfConfig,
    dbIds: { core: 'core-uuid', modules: 'modules-uuid' },
    coreName: 'unself-workbench',
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
      modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }],
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
  it('domain 形态模板：剥 /m/<id> 前缀并保留 API 透传', () => {
    const src = prefixStripWrapperSource('hello');
    expect(src).toContain("const PREFIX = '/m/hello'");
    expect(src).toContain('url.pathname.slice(PREFIX.length)');
    expect(src).toContain("import worker from './app.js'");
  });

  it('workers.dev 形态模板（#273）：根挂载不剥前缀，带 frame-ancestors = 壳 origin', () => {
    const src = prefixStripWrapperSource('hello', { mount: '', shellOrigin: 'https://unself-workbench.test-subdomain.workers.dev' });
    expect(src).toContain("const PREFIX = ''");
    expect(src).toContain("const SHELL_ORIGIN = 'https://unself-workbench.test-subdomain.workers.dev'");
    expect(src).toContain('frame-ancestors');
  });

  it('workers.dev 形态模板（#277）：注入 `unself-shell-origin` meta（Firefox 无 ancestorOrigins 的 token 通道）', () => {
    const src = prefixStripWrapperSource('hello', { mount: '', shellOrigin: 'https://unself-workbench.test-subdomain.workers.dev' });
    expect(src).toContain("const META_NAME = 'unself-shell-origin'");
  });
});

describe('migrationWranglerConfig（②迁移专用最小配置）', () => {
  it('真实 database_id + binding + 相对 migrations_dir，字段原样内嵌', () => {
    const cfg = JSON.parse(migrationWranglerConfig({
      binding: 'CORE_DB',
      databaseName: 'unself-core',
      databaseId: 'cfe45429-f564-46c5-87bb-2b3dc5e95a1e',
      migrationsDir: '../../../app/workbench/migrations/core',
    })) as { d1_databases: Array<{ binding: string; database_name: string; database_id: string; migrations_dir: string }> };
    expect(cfg.d1_databases[0]).toMatchObject({
      binding: 'CORE_DB',
      database_name: 'unself-core',
      database_id: 'cfe45429-f564-46c5-87bb-2b3dc5e95a1e',
      migrations_dir: '../../../app/workbench/migrations/core',
    });
  });
});

describe('生产组合根（@unself/workbench 的 src/entry.prod.ts）', () => {
  // 组合根从「安装器生成」变成「包内真源文件」后，这两条仍是**回归守卫**：
  // 注入是装配决策（注入丢了 = 生产开户走内存假实现），且这件事静态可判——所以用源码断言，
  // 不假装成行为断言。真正的运行期行为由 workbench 包内 test/entry-prod.test.ts 覆盖。
  const entrySource = (): string => readFileSync(join(REPO_ROOT, 'app/workbench/src/entry.prod.ts'), 'utf8');

  it('入口注入真 Stalwart 适配器（经配置校验收口），不落无参 createApp', () => {
    const src = entrySource();
    expect(src).toContain('createStalwartMailProvisioner');
    expect(src).toContain('toStalwartProvisionerConfig');
    expect(src).toContain('createMailProvisioner:');
    // 回归守卫：模块级无参固化（createApp() 零参调用）不得出现
    expect(src).not.toMatch(/createApp\(\s*\)/);
  });

  it('入口自足：只 import 包内相对路径 + 裸包名（不再有「相对路径到仓库根」那一套）', () => {
    const src = entrySource();
    expect(src).toContain("from './index'");
    expect(src).toContain("from './registry'");
    expect(src).toContain("from './security-headers'");
    expect(src).toContain("from '@unself/stalwart-provisioner'");
    // #303：不再有 ../.. 之类仓库根相对路径（那正是「打包方在 app 外面」的产物）
    expect(src).not.toMatch(/from '\.\.\//);
  });
});

describe('copySdkAssets（#283 单一真源：只搬字节，不二次构建）', () => {
  it('从 SDK dist 逐字节复制 ESM/IIFE 资产；复制后的 ESM 仍可具名 import；缺文件给人话错', async () => {
    const src = await mkdtemp(join(tmpdir(), 'unself-sdk-src-'));
    const dest = await mkdtemp(join(tmpdir(), 'unself-sdk-dest-'));
    try {
      const esmBytes =
        "export const createModuleSDK = () => ({});\nexport const resolveShellOrigin = () => undefined;\n";
      const iifeBytes = 'var __unselfSDK = {};\n';
      await writeFile(join(src, 'module-sdk.esm.js'), esmBytes);
      await writeFile(join(src, 'module-sdk.js'), iifeBytes);

      await copySdkAssets(src, dest);
      // A5 同字节：复制件与源件完全一致（安装器注入的就是包内那一份）
      expect(await readFile(join(dest, 'module-sdk.esm.js'), 'utf8')).toBe(esmBytes);
      expect(await readFile(join(dest, 'module-sdk.js'), 'utf8')).toBe(iifeBytes);

      // 行为断言：复制后的 ESM 仍可具名 import，且暴露页面用的具名符号
      const mod = (await import(pathToFileURL(join(dest, 'module-sdk.esm.js')).href)) as Record<string, unknown>;
      expect(typeof mod.createModuleSDK).toBe('function');
      expect(typeof mod.resolveShellOrigin).toBe('function');

      // 缺文件即报错（指向 SDK 构建），不做静默跳过
      await rm(join(src, 'module-sdk.js'));
      await expect(copySdkAssets(src, dest)).rejects.toThrow(/SDK 浏览器资产缺失/);
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('hello 页面 import 的资产名 == 装配生成的 ESM 资产名', async () => {
    const page = await readFile(join(REPO_ROOT, 'app/modules/hello/src/index.ts'), 'utf8');
    const specifier = /from '\.\/sdk\/([^']+)'/.exec(page)?.[1];
    expect(specifier).toBe('module-sdk.esm.js');
  });
});

describe('provisionAll（③ 壳产物：搬运 workbench 包内产物，目标目录先清空，#303）', () => {
  it('搬运 platform.shellDir 的内容；上次部署的陈旧残留零容忍', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'unself-provision-'));
    const wb = await mkdtemp(join(tmpdir(), 'unself-provision-wb-'));
    try {
      await writeWorkbenchFixture(wb);
      const platform = resolvePlatformArtifacts({ rootDir: wb, workbenchDir: wb });

      // 预置上次部署的陈旧残留（旧产物 + 陈旧标记）
      const shellAssets = join(rootDir, '.deploy/cloudflare/assets/shell');
      await mkdir(join(shellAssets, 'assets'), { recursive: true });
      await writeFile(join(shellAssets, 'stale.marker'), 'stale');
      await writeFile(join(shellAssets, 'index.html'), '<html><body>OLD BUILD</body></html>');
      await writeFile(join(shellAssets, 'assets/index-OLD.js'), 'console.log("old")');

      const provisioned = await provisionAll({
        rootDir,
        // 最小合法配置（类型断言沿用本文件现有风格）；modules 传空数组：跳过 esbuild，聚焦壳搬运
        config: { domain: '', modules: [{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } } as UnselfConfig,
        modules: [],
        dbIds: { core: 'core-uuid', modules: 'modules-uuid' },
        log: () => {},
        platform,
      });

      // 产物来自包内（当前内容，不是上次那份）
      expect(await readFile(join(shellAssets, 'index.html'), 'utf8')).toContain('FIXTURE SHELL');
      // 陈旧残留零容忍：标记与旧资产不得出现
      expect(existsSync(join(shellAssets, 'stale.marker'))).toBe(false);
      expect(existsSync(join(shellAssets, 'assets/index-OLD.js'))).toBe(false);
      expect(await readFile(join(shellAssets, 'index.html'), 'utf8')).not.toContain('OLD BUILD');
      // 返回契约未破坏（outDir 落位 .deploy/cloudflare）
      expect(provisioned.outDir).toBe(join(rootDir, '.deploy/cloudflare'));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
      await rm(wb, { recursive: true, force: true });
    }
  });
});
