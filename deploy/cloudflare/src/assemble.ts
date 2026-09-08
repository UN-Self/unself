// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 装配产物生成（③④）：
 * - core：apps/shell 构建副本作 assets（SPA fallback + run_worker_first API）+ 两 D1 真实 id + route；
 * - module：<id>.worker.js（esbuild ESM 打包）+ sdk/module-sdk.esm.js（浏览器 ESM 具名导出）
 *   + sdk/module-sdk.js（浏览器 IIFE，历史兼容）+ D1/vars/zone 路径 route。
 * 一切文件写进 <root>/.deploy/cloudflare/（gitignore），重跑整体重建 → 幂等。
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import type { UnselfConfig } from './config';
import type { ModuleRef } from './config';
import type { InstanceKeyPair } from './es256';
import type { Wrangler } from './wrangler';

export type RelPath = string;

/** 一次装配生成的全部部署参数（steps 的输入）。 */
export interface Provisioned {
  /** 装配产物根（绝对路径，<root>/.deploy/cloudflare）。 */
  outDir: string;
  /** 实例对外 base URL（https://domain 或 workers.dev）。 */
  baseUrl: string;
  /** core Worker 名。 */
  coreName: string;
  /** 生成的 core 部署配置相对路径。 */
  coreConfig: RelPath;
  /** 各选中模块的部署参数。 */
  modules: ModuleProvision[];
  /** R2 桶名（provider=r2 时）。 */
  r2Bucket?: string;
}

export interface ModuleProvision {
  id: string;
  dir: string;
  /** 生成的模块部署配置相对路径。 */
  config: RelPath;
  /** Worker 入口相对路径。 */
  workerEntry: RelPath;
}

/** 装配产物目录名（.deploy，gitignore）。 */
export const DEPLOY_DIR = '.deploy/cloudflare';

function runTool(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} 失败（${code}）：\n${stderr.slice(-1500)}`)),
    );
  });
}

/**
 * 装配（步骤③④的构建与生成部分；上传在 steps.deploy*）：
 * 1. vite build shell（若 dist 缺失或 FORCE_BUILD）→ 拷贝到 outDir/assets/shell；
 * 2. esbuild 打包每个选中模块 Worker（platform=node_modules 外置 → 无；unself 模块自包含）；
 * 3. esbuild 打包 @unself/module-sdk 为浏览器 ESM（页面具名 import）+ IIFE（兼容）→ assets/<id>/sdk/；
 * 4. 生成 core 与各模块 wrangler jsonc。
 */
export async function provisionAll(options: {
  rootDir: string;
  config: UnselfConfig;
  modules: ModuleRef[];
  dbIds: { core: string; modules: string };
  keypair: InstanceKeyPair | { existing: true };
  wrangler: Wrangler;
  log?: (msg: string) => void;
}): Promise<Provisioned> {
  const { rootDir, config, modules, dbIds, wrangler } = options;
  const log = options.log ?? console.log;
  const outDir = join(rootDir, DEPLOY_DIR);
  await mkdir(outDir, { recursive: true });

  // ---- 步骤③ 构建侧：shell ----
  const shellDist = join(rootDir, 'apps/shell/dist');
  if (!existsSync(shellDist)) {
    log('构建 shell（vite build）…');
    await runTool('pnpm', ['--filter', '@unself/shell', 'build'], rootDir);
  } else {
    log('shell dist 已存在，直接复用（幂等；需强制重建请删除 apps/shell/dist）');
  }
  const shellAssets = join(outDir, 'assets/shell');
  await rm(shellAssets);
  await cp(shellDist, shellAssets, { recursive: true });

  // ---- 实例 base URL（workers.dev 回退）----
  const coreName = 'unself-core-api';
  let baseUrl: string;
  if (config.domain) {
    baseUrl = `https://${config.domain}`;
  } else {
    // workers.dev 路径：URL 由步骤③后的 resolveBaseUrl 从真实 deploy 输出回填
    baseUrl = '';
  }

  // ---- 步骤④ 构建侧：模块 ----
  const sdkEntry = join(rootDir, 'packages/module-sdk/src/index.ts');
  const moduleProvisions: ModuleProvision[] = [];
  for (const mod of modules.filter((m) => m.selected)) {
    const modOut = join(outDir, 'modules', mod.id);
    await mkdir(modOut, { recursive: true });
    // Worker 入口（依赖打进单文件：模块部署单元自包含）
    const workerEntry = join(modOut, 'app.js');
    await build({
      entryPoints: [join(mod.dir, 'src/index.ts')],
      outfile: workerEntry,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      conditions: ['workerd', 'import'],
      external: ['@cloudflare/workers-types'],
      legalComments: 'inline',
      banner: { js: '// SPDX-License-Identifier: AGPL-3.0-only' },
      logLevel: 'silent',
    });
    // SDK 浏览器资产（页面 import ./sdk/module-sdk.esm.js → 部署期静态资产）
    await buildModuleSdkAssets(sdkEntry, join(modOut, 'assets/sdk'));
    moduleProvisions.push({
      id: mod.id,
      dir: mod.dir,
      config: `modules/${mod.id}.wrangler.jsonc`,
      workerEntry: `modules/${mod.id}/app.js`,
    });
  }

  return {
    outDir,
    baseUrl,
    coreName,
    coreConfig: 'core.wrangler.jsonc',
    modules: moduleProvisions,
    r2Bucket: config.storage.provider === 'r2' ? config.storage.bucket : undefined,
  };
}

async function rm(path: string): Promise<void> {
  if (existsSync(path)) {
    await import('node:fs/promises').then((fs) => fs.rm(path, { recursive: true, force: true }));
  }
}

/**
 * SDK 浏览器资产构建（IIFE + ESM，§5.3 页面装载）：
 * - module-sdk.js（IIFE，全局名 __unselfSDK）：历史兼容产物，无顶层 export；
 * - module-sdk.esm.js（ESM）：页面 `import { createModuleSDK } from './sdk/module-sdk.esm.js'`
 *   的命中目标——IIFE 无顶层 export，浏览器 ESM 具名导入会报 SyntaxError（T3 线上实锤）。
 */
export async function buildModuleSdkAssets(sdkEntry: string, assetsDir: string): Promise<void> {
  await mkdir(assetsDir, { recursive: true });
  await build({
    entryPoints: [sdkEntry],
    outfile: join(assetsDir, 'module-sdk.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    globalName: '__unselfSDK',
    legalComments: 'inline',
    logLevel: 'silent',
  });
  await build({
    entryPoints: [sdkEntry],
    outfile: join(assetsDir, 'module-sdk.esm.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    legalComments: 'inline',
    logLevel: 'silent',
  });
}

/** 生成 core 部署配置（含 SPA fallback + run_worker_first + 真实 D1 id + route）。 */
export function coreWranglerConfig(input: {
  config: UnselfConfig;
  dbIds: { core: string; modules: string };
  coreName: string;
}): string {
  const { config, dbIds, coreName } = input;
  const route = config.domain ? config.domain : undefined;
  return JSON.stringify(
    {
      $schema: 'node_modules/wrangler/config-schema.json',
      name: coreName,
      main: 'core-worker.js',
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      // §5.3 单域名路径制：core 与模块全部 zone 路径路由（Workers Routes），不用 Custom Domain。
      // 硬约束（#59 真机实证）：同一 host 上 Custom Domain 优先于路径路由——若 core 主域挂
      // Custom Domain，模块的 <domain>/m/<id>/* 路由会被 core 全部吞掉。故 core 亦为路由形态
      // <domain>/*，具体路径由「最长前缀胜出」分发到模块。DNS 记录由部署脚本自建（API Token
      // 带 Zone: DNS Edit）；zone 路由还需 Zone: Workers Routes Edit（OAuth 10405 背景见 README）。
      ...(route ? { routes: [{ pattern: `${route}/*` }] } : {}),
      assets: {
        directory: 'assets/shell',
        binding: 'ASSETS',
        // SPA：未命中文件回 index.html；API/JWKS 一律先跑 Worker
        not_found_handling: 'single-page-application',
        // v4：'/setup' 精确路径命中 CF 内部处理并 404（未知机理）；'/setup*' 等价覆盖 /setup 与其查询串，且不误伤 /setupX（SPA 兜底）
        run_worker_first: ['/api/*', '/.well-known/*', '/setup*'],
      },
      d1_databases: [
        {
          binding: 'CORE_DB',
          database_name: 'unself-core',
          database_id: dbIds.core,
        },
        {
          binding: 'MODULES_DB',
          database_name: 'unself-modules',
          database_id: dbIds.modules,
        },
      ],
      vars: {
        ...(config.domain ? { UNSELF_BASE_URL: `https://${config.domain}` } : {}),
      },
      observability: { enabled: true },
    },
    null,
    2,
  );
}

/** 生成模块部署配置（前缀剥除 wrapper + D1 绑定 + CORE_JWKS_URL + route）。 */
export function moduleWranglerConfig(input: {
  config: UnselfConfig;
  dbIds: { modules: string };
  mod: { id: string };
  jwksPath: string;
  /** baseUrl 已知时直接给完整 JWKS URL（workers.dev 场景在步骤③后才可知）。 */
  jwksUrl?: string;
}): string {
  const { config, dbIds, mod, jwksPath, jwksUrl } = input;
  const host = config.domain || 'workers.dev-placeholder';
  return JSON.stringify(
    {
      $schema: 'node_modules/wrangler/config-schema.json',
      name: `unself-module-${mod.id}`,
      // wrangler v4 的 main/assets 相对「配置文件所在目录」解析（本配置在 modules/ 下）
      main: `${mod.id}/worker.js`, // wrapper 独占入口；bundle 在 app.js（同目录）
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      // §5.3 单域名路径制：zone 路径路由（无 custom_domain 标记 = 不自动建 DNS/证书），
      // 模块与 core 同域，按 /m/<id>/* 前缀分发。pattern 用 config.domain 全值
      // （多级子域推不出 zone，如 demo.handywote.top ∈ handywote.top；zone 解析交由
      // wrangler 按 pattern 匹配，待真机验证——见 README 假设注记）。
      ...(config.domain
        ? { routes: [{ pattern: `${config.domain}/m/${mod.id}/*` }] }
        : {}),
      assets: {
        directory: `${mod.id}/assets`,
        binding: 'ASSETS',
        not_found_handling: 'none',
        // wrangler v4 路径规则须以 / 开头；等价全部请求先跑 Worker（模块自管资产回退）
        run_worker_first: true,
      },
      d1_databases: [
        {
          binding: 'MODULES_DB',
          database_name: 'unself-modules',
          database_id: dbIds.modules,
        },
      ],
      vars: {
        MODULE_ID: mod.id,
        CORE_JWKS_URL: jwksUrl ?? `https://${host}${jwksPath}`,
      },
      observability: { enabled: true },
    },
    null,
    2,
  );
}

/** 迁移专用最小配置：真实 database_id；migrations_dir 相对本配置所在目录（调用方算好相对路径）。 */
export function migrationWranglerConfig(input: {
  binding: string;
  databaseName: string;
  databaseId: string;
  migrationsDir: string;
}): string {
  const cfg = {
    d1_databases: [{
      binding: input.binding,
      database_name: input.databaseName,
      database_id: input.databaseId,
      migrations_dir: input.migrationsDir,
    }],
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

/** 写文件（自动建目录）。 */
export async function writeConfig(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/** 模块路由前缀 wrapper 代码模板（运行时剥 /m/<id> 前缀 + 静态资产回退）。 */
export function prefixStripWrapperSource(moduleId: string): string {
  return `// SPDX-License-Identifier: AGPL-3.0-only
// 由 deploy/cloudflare 生成：剥 /m/${moduleId} 前缀 + ASSETS 回退。
import worker from './app.js';

const PREFIX = '/m/${moduleId}';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isAsset = !url.pathname.startsWith(PREFIX + '/api/') &&
                    !url.pathname.startsWith(PREFIX + '/life/') &&
                    request.method === 'GET';
    if (isAsset && url.pathname.length > PREFIX.length + 1) {
      // 页面以相对路径引用资产（import './sdk/module-sdk.esm.js' → 请求
      // /m/<id>/sdk/...），剥前缀后= sdk/... 命中部署期静态资产。
      // 仅前缀本身（/m/<id>/ 或 /m/<id>）不是资产：落 worker 根分支，
      // 由 Hono 渲染模块页（模块无 index.html 静态文件）
      const assetPath = url.pathname.slice(PREFIX.length + 1);
      return env.ASSETS.fetch(new URL('/' + assetPath, url.origin));
    }
    // 模块代码按「部署在根路径」编写：剥掉挂载前缀
    url.pathname = url.pathname.slice(PREFIX.length) || '/';
    const headers = new Headers(request.headers);
    // 仅根路径回 index.html：页面内相对引用已在浏览器侧按 /m/<id>/ 解析（不改写 URL/头）
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      const asset = await env.ASSETS.fetch(new URL('/index.html', url.origin).toString(), request);
      if (asset.status !== 404) return asset;
    }
    // Hono 实例是对象非函数：走 .fetch（与 core 入口同款调用约定）
    return worker.fetch(new Request(url, { method: request.method, headers, body: request.body, duplex: 'half' }), env, ctx);
  },
};
`;
}
