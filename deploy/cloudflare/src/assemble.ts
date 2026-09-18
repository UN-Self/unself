// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 装配产物生成（③④）：
 * - core：apps/shell 构建副本作 assets（SPA fallback + run_worker_first API）+ 两 D1 真实 id + route；
 * - module：<id>.worker.js（esbuild ESM 打包）+ sdk/module-sdk.esm.js（浏览器 ESM 具名导出）
 *   + sdk/module-sdk.js（浏览器 IIFE，历史兼容）+ D1/vars/zone 路径 route。
 * 一切文件写进 <root>/.deploy/cloudflare/（gitignore），重跑整体重建 → 幂等。
 * shell 每次部署都重建（vite build），不复用 apps/shell/dist 旧产物（#73）：部署器职责=始终搬运当前源码树。
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type { ModuleManifest } from '@unself/contracts';
import type { UnselfConfig } from './config';
import type { ModuleRef } from './config';
import type { ArtifactRoots } from './artifacts';
import { coreDbName, coreWorkerName, modulesDbName, moduleWorkerName, resourceName } from './naming';

export type RelPath = string;

/** 一次装配生成的全部部署参数（steps 的输入）。 */
export interface Provisioned {
  /** 装配产物根（绝对路径，<root>/.deploy/cloudflare）。 */
  outDir: string;
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
  /** SDK/页面静态资产目录（相对 outDir；无资产模块 undefined）。 */
  assetsDir?: string;
  /** 解析后的 manifest（#248：存储落点判定用；builtin 模块 undefined 时按 preferred??core）。 */
  manifest?: ModuleManifest;
}

/** 装配产物目录名（.deploy，gitignore）。 */
export const DEPLOY_DIR = '.deploy/cloudflare';

/** 子进程工具执行（shell=false，参数数组；stderr 尾部随错误抛出）。 */
export function runTool(
  cmd: string,
  args: string[],
  cwd: string,
  opts?: { env?: Record<string, string> },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    });
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
 * 1. vite build shell（每次部署无条件重建，杜绝 dist 陈旧复用，#73）→ 拷贝到 outDir/assets/shell；
 * 2. esbuild 打包每个选中模块 Worker（platform=node_modules 外置 → 无；unself 模块自包含）；
 * 3. esbuild 打包 @unself/module-sdk 为浏览器 ESM（页面具名 import）+ IIFE（兼容）→ assets/<id>/sdk/；
 * 4. 生成 core 与各模块 wrangler jsonc。
 */
export async function provisionAll(options: {
  rootDir: string;
  config: UnselfConfig;
  modules: ModuleRef[];
  dbIds: { core: string; modules: string };
  log?: (msg: string) => void;
  /**
   * 测试注入口：拦截 shell 构建（默认真实跑 pnpm --filter @unself/shell build）。
   * 签名只吃 rootDir：构建产物约定落 apps/shell/dist，由随后 cp 搬运。
   */
  buildShell?: (rootDir: string) => Promise<void>;
  /**
   * 产物根（#257）：给了就**不再读仓库源码树**——shell / SDK / builtin 模块 worker 全部从
   * `<installer>/dist/artifacts/**` 搬运（预打包产物）；缺省 = 仓库开发形态（现行为不变）。
   */
  artifacts?: ArtifactRoots | null;
}): Promise<Provisioned> {
  const { rootDir, config, modules } = options;
  const artifacts = options.artifacts ?? null;
  const log = options.log ?? console.log;
  const buildShell =
    options.buildShell ?? ((dir) => runTool('pnpm', ['--filter', '@unself/shell', 'build'], dir));
  const outDir = join(rootDir, DEPLOY_DIR);
  await mkdir(outDir, { recursive: true });

  // ---- 步骤③ 构建侧：shell ----
  const shellAssets = join(outDir, 'assets/shell');
  if (artifacts) {
    // 产物形态：shell 已在安装器构建期用 vite 构建好，随 tarball 分发（干净机器没有 pnpm/vite）
    log('搬运 shell 产物（安装器包内 artifacts/shell）…');
    await ensureEmptyDir(shellAssets);
    await cp(artifacts.shellDir, shellAssets, { recursive: true });
  } else {
    // 仓库形态：每次部署无条件重建（vite build，杜绝 dist 陈旧复用，#73）
    const shellDist = join(rootDir, 'apps/shell/dist');
    log('构建 shell（vite build）…');
    await buildShell(rootDir);
    await ensureEmptyDir(shellAssets);
    await cp(shellDist, shellAssets, { recursive: true });
  }

  // ---- 步骤④ 构建侧：模块 ----
  const sdkEntry = join(rootDir, 'packages/module-sdk/src/index.ts');
  const moduleProvisions: ModuleProvision[] = [];
  for (const mod of modules.filter((m) => m.selected)) {
    const modOut = join(outDir, 'modules', mod.id);
    await mkdir(modOut, { recursive: true });
    // Worker 入口（依赖打进单文件：模块部署单元自包含）。
    // 入口约定：包 package.json main（hello=src/index.ts、chat=worker/src/index.js）；
    // 无包描述的裸目录回退 src/index.ts（最小仓库场景）。
    const workerEntry = join(modOut, 'app.js');
    // 已打包形态（包根带预构建 worker.js）——**不问 artifacts**：远端来源（npm/github/https tarball）
    // 与 builtin 包都必须是自包含单文件（决策 #58/#60），重打包会改变字节并可能引入额外包裹。
    // 只有源码形态（仓库 builtin、file: 本地源码）才走 esbuild。
    const prebuilt = join(mod.dir, 'worker.js');
    if (existsSync(prebuilt)) {
      await cp(prebuilt, workerEntry);
    } else {
      await bundleModuleWorker(await moduleWorkerEntry(mod.dir), workerEntry);
    }
    // SDK 浏览器资产（页面 import ./sdk/module-sdk.esm.js → 部署期静态资产）
    const sdkAssetsDir = join(modOut, 'assets/sdk');
    if (artifacts) await copySdkAssets(artifacts.sdkDir, sdkAssetsDir);
    else await buildModuleSdkAssets(sdkEntry, sdkAssetsDir);
    moduleProvisions.push({
      id: mod.id,
      dir: mod.dir,
      config: `modules/${mod.id}.wrangler.jsonc`,
      workerEntry: `modules/${mod.id}/app.js`,
      assetsDir: `modules/${mod.id}/assets`,
      ...(mod.resolved ? { manifest: mod.resolved.manifest } : {}),
    });
  }

  // ---- core Worker 名（baseUrl 由 steps.ts 的 resolveBaseUrl 决策，不在此估算）----
  const coreName = coreWorkerName();

  return {
    outDir,
    coreName,
    coreConfig: 'core.wrangler.jsonc',
    modules: moduleProvisions,
    r2Bucket: config.storage.provider === 'r2' ? config.storage.bucket : undefined,
  };
}

/**
 * 模块 Worker 打包（依赖打进单文件）。
 * esbuild **惰性导入**（#257）：安装器产物形态不需要 esbuild（worker.js 已预打包），
 * 打包时把它标为 external 即可——干净机器不装 esbuild 也能跑完九步。
 */
export async function bundleModuleWorker(entry: string, outfile: string): Promise<void> {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    // 打包可复现（#269）：esbuild 的路径注释相对 `absWorkingDir`（缺省 = esbuild 服务启动时的 cwd，
    // 随调用方 cwd 漂移：同一个模块由 pack 与由装配器打包会产出不同字节）。固定为入口文件所在目录，
    // 使「同内容」在任何 cwd / 任何打包路径下产出逐字节一致（验收③「换成同内容的本地 tarball 结果一致」）。
    absWorkingDir: dirname(resolvePath(entry)),
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'import'],
    external: ['@cloudflare/workers-types'],
    legalComments: 'inline',
    banner: { js: '// SPDX-License-Identifier: AGPL-3.0-only' },
    logLevel: 'silent',
  });
}

async function rm(path: string): Promise<void> {
  if (existsSync(path)) {
    await import('node:fs/promises').then((fs) => fs.rm(path, { recursive: true, force: true }));
  }
}

/** 确保目录为空壳（先删后建；并发/重入下的 mkdir EEXIST 竞态免疫，#219 装配测试实证）。 */
async function ensureEmptyDir(path: string): Promise<void> {
  await rm(path);
  await mkdir(path, { recursive: true });
}

/**
 * 模块 Worker 打包入口解析（#219）：包 package.json main 优先（hello=src/index.ts、
 * chat=worker/src/index.js），缺失回退 src/index.ts（裸目录最小场景）。
 * main 指向的文件不存在 → 人话报错（不在 esbuild 里炸难懂错）。
 */
export async function moduleWorkerEntry(moduleDir: string): Promise<string> {
  // 已打包形态（#245）：包根直接带预构建 worker.js（manifest.runtimes ∋ worker 的模块包标准入口）
  const prebuilt = join(moduleDir, 'worker.js');
  if (existsSync(prebuilt)) return prebuilt;
  const fallback = join(moduleDir, 'src/index.ts');
  const pkgPath = join(moduleDir, 'package.json');
  if (!existsSync(pkgPath)) return fallback;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { main?: string };
    if (!pkg.main) return fallback;
    const main = join(moduleDir, pkg.main);
    if (!existsSync(main)) {
      throw new Error(`模块包 package.json main 指向的文件不存在：${pkg.main}`);
    }
    return main;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`模块包 package.json 不是合法 JSON：${pkgPath}`);
    }
    throw err;
  }
}

/**
 * SDK 浏览器资产构建（IIFE + ESM，§5.3 页面装载）：
 * - module-sdk.js（IIFE，全局名 __unselfSDK）：历史兼容产物，无顶层 export；
 * - module-sdk.esm.js（ESM）：页面 `import { createModuleSDK } from './sdk/module-sdk.esm.js'`
 *   的命中目标——IIFE 无顶层 export，浏览器 ESM 具名导入会报 SyntaxError（T3 线上实锤）。
 */
export async function buildModuleSdkAssets(sdkEntry: string, assetsDir: string): Promise<void> {
  const { build } = await import('esbuild');
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

/** 产物形态搬运 SDK 资产（module-sdk.js + module-sdk.esm.js）：干净机器无 esbuild，直接抄预构建产物。 */
async function copySdkAssets(sdkDir: string, assetsDir: string): Promise<void> {
  await mkdir(assetsDir, { recursive: true });
  for (const name of ['module-sdk.js', 'module-sdk.esm.js']) {
    const from = join(sdkDir, name);
    if (!existsSync(from)) {
      throw new Error(`安装器产物不完整：缺 ${from}（SDK 浏览器资产）——重跑 \`pnpm --filter @unself/installer build\` 重新生成产物`);
    }
    await cp(from, join(assetsDir, name));
  }
}

/** core 资产的 run_worker_first（#273）：domain 形态保持原精确前缀数组（生产路径零变更）；
 * workers.dev 形态 = true——壳 HTML 必须经 worker 才能下发按注册表生成的 frame-src 白名单
 * （跨子域模块 iframe 需 shell 响应头含模块 origin；静态资产路径的 `_headers` 是静态值改不了）。 */
export function coreRunWorkerFirst(config: UnselfConfig): boolean | string[] {
  return config.domain ? ['/api/*', '/.well-known/*', '/setup*'] : true;
}

/** 生成 core 部署配置（含 SPA fallback + run_worker_first + 真实 D1 id + route）。 */
export function coreWranglerConfig(input: {
  config: UnselfConfig;
  dbIds: { core: string; modules: string };
  coreName: string;
  /** zone 路由必填（wrangler schema：routes[] 元素需 zone_id|zone_name）；部署脚本经 API 探测注入。 */
  zoneName?: string;
}): string {
  const { config, dbIds, coreName, zoneName } = input;
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
      ...(route ? { routes: [{ pattern: `${route}/*`, zone_name: zoneName }] } : {}),
      assets: {
        directory: 'assets/shell',
        binding: 'ASSETS',
        // SPA：未命中文件回 index.html；API/JWKS 一律先跑 Worker
        not_found_handling: 'single-page-application',
        // v4：'/setup' 精确路径命中 CF 内部处理并 404（未知机理）；'/setup*' 等价覆盖 /setup 与其查询串，且不误伤 /setupX（SPA 兜底）
        // workers.dev 形态（#273）：true = 全部经 worker，壳 HTML 才能带动态 frame-src 白名单
        run_worker_first: coreRunWorkerFirst(config),
      },
      d1_databases: [
        {
          binding: 'CORE_DB',
          database_name: coreDbName(),
          database_id: dbIds.core,
        },
        {
          binding: 'MODULES_DB',
          database_name: modulesDbName(),
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

/** 生成模块部署配置（前缀剥除 wrapper + D1 绑定 + CORE_JWKS_JSON + route）。 */
export function moduleWranglerConfig(input: {
  config: UnselfConfig;
  dbIds: { modules: string };
  mod: { id: string };
  /** 部署期注入的 core 公钥 JWKS 字符串（模块本地验签，零运行时网络，§5.2/#71 根因①）。 */
  jwksJson: string;
  /** zone 路由必填（wrangler schema：routes[] 元素需 zone_id|zone_name）；部署脚本经 API 探测注入。 */
  zoneName?: string;
  /** 数据落点（#248 四级）：shared/external → 绑 MODULES_DB（external 建表归模块自身库，这里仅共用绑定名）；
   *  dedicated → 额外绑专属库 `<id>_DB`（unself-<id>）；core → 仅 MODULES_DB（SDK 走 Core API 代理）。 */
  storageLevel?: 'core' | 'shared' | 'dedicated' | 'external';
  /** dedicated 专属库 id（storageLevel=dedicated 时必填）。 */
  dedicatedDbId?: string;
}): string {
  const { config, dbIds, mod, jwksJson, zoneName, storageLevel = 'core', dedicatedDbId } = input;
  return JSON.stringify(
    {
      $schema: 'node_modules/wrangler/config-schema.json',
      name: moduleWorkerName(mod.id),
      // wrangler v4 的 main/assets 相对「配置文件所在目录」解析（本配置在 modules/ 下）
      main: `${mod.id}/worker.js`, // wrapper 独占入口；bundle 在 app.js（同目录）
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      // §5.3 单域名路径制：zone 路径路由（无 custom_domain 标记 = 不自动建 DNS/证书），
      // 模块与 core 同域，按 /m/<id>/* 前缀分发。zone_name 由部署脚本经 API 探测注入
      // （wrangler schema 必填，多级子域推不出 zone，故不引入 config zone 字段）。
      ...(config.domain
        ? { routes: [{ pattern: `${config.domain}/m/${mod.id}/*`, zone_name: zoneName }] }
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
          database_name: modulesDbName(),
          database_id: dbIds.modules,
        },
        ...(storageLevel === 'dedicated'
          ? [
              {
                binding: `${mod.id.toUpperCase().replaceAll('-', '_')}_DB`,
                database_name: resourceName(mod.id),
                database_id: dedicatedDbId ?? '',
              },
            ]
          : []),
      ],
      // core 级（#248 收敛（a)）：模块唯一数据通道 = Core API 代理；与 core-api 的跨 worker 调用
      // 只能走 Service Binding（同 zone 明文 fetch 被 CF 平台禁，见 #71 根因①）。steps.ts 上传时
      // 也注入同名绑定——配置产物与真实部署面保持一致（生成物可核对，不是唯一输入源）。
      ...(storageLevel === 'core' ? { services: [{ binding: 'CORE_API', service: coreWorkerName() }] } : {}),
      vars: {
        MODULE_ID: mod.id,
        // 数据落点（#248）：模块 SDK 据此决定存储通道（core=Core API 代理；shared/dedicated=直连建表；external=外部连接串）
        STORAGE_LEVEL: storageLevel,
        // 部署期注入公钥 JWKS：模块本地验签零运行时网络（#71 根因①：跨 Worker 拉 core JWKS)
        // 被 CF 同 zone 禁令拦截 → 恒 401。换钥 = core secret 更新后重跑部署同步。
        CORE_JWKS_JSON: jwksJson,
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

/**
 * core Worker 入口打包（REST 化后无 wrangler deploy 的隐式 bundle，自打包）。
 * 必须在 core-worker.js 模板写盘【之后】调用（entry 是它的产物——探针曾因错序用到上一轮陈旧入口，测试已锁）。
 */
export async function bundleCoreWorker(entry: string, outfile: string): Promise<void> {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'import'],
    external: ['@cloudflare/workers-types', 'cloudflare:sockets', 'cloudflare:email'],
    legalComments: 'inline',
    banner: { js: '// SPDX-License-Identifier: AGPL-3.0-only' },
    logLevel: 'silent',
  });
}

/** 写文件（自动建目录）。 */
export async function writeConfig(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/** 模块 wrapper 生成选项（#273 + #277）。 */
export interface ModuleWrapperOptions {
  /** 挂载前缀：domain 形态 = `/m/<id>`；workers.dev 形态 = `''`（模块自有子域根挂载）。
   *  缺省 = `/m/<id>`（存量调用方兼容）。 */
  mount?: string;
  /** 壳 origin（壳上下文注入值：frame-ancestors + `unself-shell-origin` meta）；null/缺省 = 不注入任何壳上下文。 */
  shellOrigin?: string | null;
}

/**
 * 模块入口 wrapper 代码模板（#273 形态化）：
 * - 前缀剥除（domain 形态）：命中 `/m/<id>` 才剥，根挂载（workers.dev）原样——
 *   「模块恒挂根路径」不变式（决策 #63）两形态都成立；
 * - 静态资产回退（ASSETS）；
 * - 壳上下文注入（决策 #63/#73 + #277）：
 *   - frame-ancestors：值 = 壳 origin（模块页自负）——跨子域 iframe 才不会被浏览器裁掉；
 *   - `<meta name="unself-shell-origin">`：Firefox 无 ancestorOrigins，模块页 JS 读它校验入站 token；
 *     触发条件 = shellOrigin 非 null 且响应为 text/html 且非无 body 状态（101/204/205/304）。
 */
export function prefixStripWrapperSource(moduleId: string, options: ModuleWrapperOptions = {}): string {
  const mount = options.mount ?? `/m/${moduleId}`;
  const shellOrigin = options.shellOrigin ?? null;
  return `// SPDX-License-Identifier: AGPL-3.0-only
// 由 deploy/cloudflare 生成：前缀剥除（mount=${mount || '(根挂载)'}）+ ASSETS 回退 + 壳上下文（frame-ancestors + shell-origin meta）。
import worker from './app.js';

const PREFIX = '${mount}';
const SHELL_ORIGIN = ${shellOrigin ? `'${shellOrigin}'` : 'null'};
const META_NAME = 'unself-shell-origin';
const BODYLESS = [101, 204, 205, 304];

// 壳上下文注入（决策 #63/#73，#277）：
// - frame-ancestors：值 = 壳 origin；已有 CSP 则合并，不覆盖模块自身策略；
// - shell-origin <meta>：Firefox 无 ancestorOrigins，模块页 JS 读它校验入站 token
//   （用 <meta> 不动 script：CSP 安全）。触发条件：HTML 且非无 body 状态；
//   幂等只豁免 meta 插入（已含则不重复插）；frame-ancestors 照补、失真标头照删。
async function withShellContext(res) {
  if (!SHELL_ORIGIN) return res;
  const headers = new Headers(res.headers);
  const contentType = headers.get('Content-Type') || '';
  const nullBody = BODYLESS.includes(res.status);
  const isHtml = contentType.includes('text/html');
  if (isHtml && !nullBody) {
    // frame-ancestors 照补（幂等不豁免）：已有则保留模块自身策略，否则并入
    const existing = headers.get('Content-Security-Policy');
    if (!(existing && /frame-ancestors/i.test(existing))) {
      headers.set('Content-Security-Policy', existing ? existing + '; ' + 'frame-ancestors ' + SHELL_ORIGIN : 'frame-ancestors ' + SHELL_ORIGIN);
    }
    // meta 注入：已含（幂等标记）只跳过插入，不重复；否则插 <head> 开标签后 / 前置最前
    const bodyText = await res.text();
    let body = bodyText;
    if (!bodyText.includes('name="' + META_NAME + '"')) {
      const meta = '<meta name="' + META_NAME + '" content="' + SHELL_ORIGIN.replace(/"/g, '&quot;') + '">';
      const headOpen = /<head[^>]*>/i.exec(bodyText);
      if (headOpen) {
        const at = headOpen.index + headOpen[0].length;
        body = bodyText.slice(0, at) + meta + bodyText.slice(at);
      } else {
        body = meta + bodyText;
      }
    }
    // body 已被 text() 解码重建：失真的长度/编码标头必须删（幂等短路也不例外）
    headers.delete('Content-Encoding');
    headers.delete('Content-Length');
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  }
  // 非 HTML / 无 body 状态：只补 frame-ancestors（#273 语义原样），body 不动
  const existing = headers.get('Content-Security-Policy');
  if (existing && /frame-ancestors/i.test(existing)) return res;
  const directive = 'frame-ancestors ' + SHELL_ORIGIN;
  headers.set('Content-Security-Policy', existing ? existing + '; ' + directive : directive);
  return new Response(nullBody ? null : res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 前缀剥除（domain 形态）：仅命中挂载前缀才剥；根挂载（workers.dev）原样。
    const prefixed = PREFIX !== '' && (url.pathname === PREFIX || url.pathname.startsWith(PREFIX + '/'));
    const path = prefixed ? (url.pathname.slice(PREFIX.length) || '/') : url.pathname;
    const isAsset = !path.startsWith('/api/') && !path.startsWith('/life/') && request.method === 'GET';
    if (isAsset && path !== '/') {
      // 页面以相对路径引用资产（import './sdk/module-sdk.esm.js' → 请求
      // /sdk/... 或 /m/<id>/sdk/...），剥前缀后 = sdk/... 命中部署期静态资产。
      // 仅根路径本身（/ 或挂载前缀）不是资产：落 worker 根分支，由 Hono 渲染模块页。
      return withShellContext(await env.ASSETS.fetch(new URL(path, url.origin)));
    }
    // 仅根路径回 index.html：页面内相对引用已在浏览器侧按当前基址解析（不改写 URL/头）
    if (request.method === 'GET' && path === '/') {
      const asset = await env.ASSETS.fetch(new URL('/index.html', url.origin).toString(), request);
      if (asset.status !== 404) return withShellContext(asset);
    }
    // 模块代码按「部署在根路径」编写：剥掉挂载前缀
    url.pathname = path;
    const headers = new Headers(request.headers);
    // Hono 实例是对象非函数：走 .fetch（与 core 入口同款调用约定）
    const res = await worker.fetch(new Request(url, { method: request.method, headers, body: request.body, duplex: 'half' }), env, ctx);
    return withShellContext(res);
  },
};
`;
}
