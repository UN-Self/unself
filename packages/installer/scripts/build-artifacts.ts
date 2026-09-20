// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 安装器产物构建（#257；#284 只搬「平台产物」）：把九步装配运行期需要的**平台产物**预构建进 `dist/artifacts/**`。
 *
 * 为什么：安装器要在**没有本仓库**的干净机器上部署实例。引擎原先从 rootDir 读
 * `services/core-api/migrations`（迁移 SQL）、`apps/shell/dist`（壳产物）、`services/core-api/src`（core Worker 入口）——
 * 干净机器上这些都不存在。本脚本在**安装器构建期**（有仓库、有 pnpm/vite/esbuild）把它们做成产物：
 *
 *   dist/artifacts/
 *     manifest.json                产物清单（formatVersion=1，引擎据此判定「产物模式」）
 *     core/worker.js               预打包 core Worker bundle（core-api + Stalwart 适配器 + 安全头）
 *     core/migrations/core/*.sql   core 迁移 SQL
 *     core/migrations/modules/*.sql 平台基建迁移 SQL
 *     shell/…                      apps/shell 的 vite 产物（壳）
 *     vendor/blake3-wasm/…         资产哈希依赖（wasm 用 fs 相对路径加载，无法进 bundle）
 *
 * **模块与 SDK 不在产物里（#284 / 决策 #76/#77）**：官方模块（`@unself/hello` / `@unself/chat`）
 * 与浏览器侧 SDK（`@unself/sdk`）都是普通 npm 包，由安装器 `dependencies` 精确预装，
 * 引擎从 node_modules 解析（本地命中则零网络）。模块包由 `unself module pack` 产出（#285）。
 * chat 前端产物由 `pnpm -r build`（frontend 包的 vite build，live 模式）落到 `modules/chat/assets/frontend`，
 * 随模块包打包——本脚本不再插手模块内部。
 *
 * 纪律：
 * - 所有子构建写**隔离 outDir**（dist/.artifacts-work），不碰仓库内 apps/shell/dist——
 *   否则与 `pnpm -r build` 里各包自己的构建并发写同一目录（脏产物/半套）。
 * - core worker 的 esbuild 参数**复用引擎的导出函数**（bundleCoreWorker）。
 * - 产物构建失败即非 0 退出：宁可不产出 tarball，也不产出半个产物（引擎会带着残产物「看起来能跑」）。
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ARTIFACTS_FORMAT_VERSION,
  bundleCoreWorker,
  coreWorkerEntrySource,
} from '../src/engine/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER_DIR = join(HERE, '..');
const REPO_ROOT = join(INSTALLER_DIR, '..', '..');
const DIST_DIR = join(INSTALLER_DIR, 'dist');
const ARTS_DIR = join(DIST_DIR, 'artifacts');
/** 隔离工作区（子构建产物先落这里，再挑需要的搬进 artifacts；跑完删）。 */
const WORK_DIR = join(DIST_DIR, '.artifacts-work');

/** 子进程执行（shell=false；stderr 尾部随错误抛出）。 */
function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on('error', (err) => reject(new Error(`无法运行 ${cmd}（PATH 里没有？）：${err.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} 失败（退出码 ${code}）`)),
    );
  });
}

async function main(): Promise<void> {
  console.log('▣ 构建安装器平台产物（issue 257 / 284）：core / shell / 迁移 SQL / vendor');
  await rm(ARTS_DIR, { recursive: true, force: true });
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(ARTS_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });

  // ---- 1. core Worker bundle（含 core-api + Stalwart 适配器；入口模板复用引擎的 coreWorkerEntrySource）----
  const coreTmp = join(WORK_DIR, 'core');
  await mkdir(coreTmp, { recursive: true });
  const coreEntry = join(coreTmp, 'core-worker.js');
  await writeFile(coreEntry, coreWorkerEntrySource(coreTmp, REPO_ROOT));
  await mkdir(join(ARTS_DIR, 'core'), { recursive: true });
  await bundleCoreWorker(coreEntry, join(ARTS_DIR, 'core', 'worker.js'));
  console.log('  ✓ core/worker.js（预打包 core Worker）');

  // ---- 2. core / 平台 迁移 SQL ----
  const coreMigSrc = join(REPO_ROOT, 'services/core-api/migrations/core');
  const platformMigSrc = join(REPO_ROOT, 'services/core-api/migrations/modules');
  if (!existsSync(coreMigSrc)) throw new Error(`core 迁移目录缺失：${coreMigSrc}`);
  await cp(coreMigSrc, join(ARTS_DIR, 'core', 'migrations', 'core'), { recursive: true });
  if (existsSync(platformMigSrc)) {
    await cp(platformMigSrc, join(ARTS_DIR, 'core', 'migrations', 'modules'), { recursive: true });
  }
  console.log('  ✓ core/migrations/**（core + 平台基建 SQL）');

  // ---- 3. shell（隔离 outDir，避免与 apps/shell 自己的 build 抢 dist/）----
  const shellOut = join(WORK_DIR, 'shell');
  await run(
    'pnpm',
    ['--filter', '@unself/shell', 'exec', 'vite', 'build', '--outDir', shellOut, '--emptyOutDir'],
    REPO_ROOT,
  );
  if (!existsSync(join(shellOut, 'index.html'))) {
    throw new Error(`shell 产物缺失 index.html：${shellOut}（vite build 报成功但无产物？）`);
  }
  await cp(shellOut, join(ARTS_DIR, 'shell'), { recursive: true });
  console.log('  ✓ shell/**（apps/shell 的 vite 产物）');

  // ---- 4. vendor：blake3-wasm（createRequire 加载，wasm 必须真实文件树）----
  const engineRequire = createRequire(join(INSTALLER_DIR, 'package.json'));
  const blake3PkgDir = dirname(engineRequire.resolve('blake3-wasm/package.json'));
  await cp(blake3PkgDir, join(ARTS_DIR, 'vendor', 'blake3-wasm'), { recursive: true });
  console.log('  ✓ vendor/blake3-wasm/（资产哈希依赖）');

  // ---- 5. 许可证随包（AGPL 交付要求；根 LICENSE/NOTICE 拷进 dist/）----
  for (const name of ['LICENSE', 'NOTICE']) {
    if (existsSync(join(REPO_ROOT, name))) {
      await cp(join(REPO_ROOT, name), join(DIST_DIR, name));
      console.log(`  ✓ dist/${name}（根 ${name} 随包）`);
    }
  }

  // ---- 6. 产物 manifest（引擎据此判定「产物模式」+ 版本；格式见 src/engine/artifacts.ts）----
  const installerPkg = JSON.parse(await readFile(join(INSTALLER_DIR, 'package.json'), 'utf8')) as { version?: string };
  await writeFile(
    join(ARTS_DIR, 'manifest.json'),
    `${JSON.stringify(
      {
        formatVersion: ARTIFACTS_FORMAT_VERSION,
        installerVersion: installerPkg.version ?? '0.0.0',
        generatedAt: new Date().toISOString(),
        node: process.version,
        layout: {
          coreWorker: 'core/worker.js',
          coreMigrations: 'core/migrations/core',
          platformMigrations: 'core/migrations/modules',
          shell: 'shell',
          vendor: 'vendor',
        },
      },
      null,
      2,
    )}\n`,
  );
  console.log('  ✓ manifest.json（formatVersion=' + ARTIFACTS_FORMAT_VERSION + '）');

  await rm(WORK_DIR, { recursive: true, force: true });
  console.log('▣ 安装器产物就绪：dist/artifacts/');
}

await main();
