// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 产物根解析（#257）：引擎从「随安装器分发的产物」读 core / shell / 迁移 SQL / vendor，
 * `rootDir` 只当**输出目录**（实例目录，落 `.deploy/`、`unself.lock`）。
 *
 * **模块与 SDK 不在产物里（#284 / 决策 #76/#77）**：官方模块就是普通 npm 包，SDK 也是发布的包；
 * 两者都由安装器 `dependencies` 精确预装，引擎从 `node_modules` 解析（本地优先，零网络）。
 * 平台产物（core worker bundle / 壳 / 迁移 SQL / vendor）保持内嵌。
 *
 * 为什么需要它：`npx` / tarball 装出来的安装器所在的机器**没有本仓库**——九步引擎若仍从
 * `rootDir/modules`、`rootDir/services`、`rootDir/apps/shell/dist` 读源码树，干净机器必然部署不出来。
 *
 * 两种运行形态（同一条代码路径，只换「产物根」这一处输入）：
 * - **安装器产物形态**：引擎被打进 `<installer>/dist/unself.mjs`，同目录 `dist/artifacts/` 随 tarball 分发
 *   → 自动探测命中，九步全程不碰 rootDir 下的源码树；
 * - **仓库开发形态**：`<engine>/src/artifacts` 不存在 → 返回 null → 全部路径回落到 rootDir 源码树
 *   （开发者体验零改动）。
 *
 * 解析顺序（显式 > 环境变量 > 自探测；前三者优先级递减）：
 * 1. `runNineSteps({ artifactRoot })` 显式入参（测试 / 嵌入式）；
 * 2. `UNSELF_ARTIFACTS` 环境变量；
 * 3. `<引擎模块目录>/artifacts`（打包产物布局：dist/unself.mjs → dist/artifacts/）。
 *
 * **显式/环境指定的路径必须合法**（缺 manifest.json / formatVersion 不符 → 直接抛错，不静默回落）；
 * 自探测缺失才算仓库形态（否则「把产物根指到空目录」会静默回落成仓库路径，红灯探针失去意义）。
 *
 * 契约/形状类实测版本：产物 manifest `formatVersion: 1`（Node v26.8.2 实测，见 docs/audit/#257 报告）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve as resolvePath } from 'node:path';

/** 产物 manifest 的格式版本（引擎拒绝不认识的产物根，防「新产物 + 旧引擎」静默走偏）。 */
export const ARTIFACTS_FORMAT_VERSION = 1;

/** 产物根（内置判据 = manifest.json + formatVersion）。 */
export interface ArtifactRoots {
  /** 产物根绝对路径（<installer>/dist/artifacts）。 */
  root: string;
  /** 产物 manifest（格式版本/生成信息）。 */
  manifestPath: string;
  /** 预打包 core Worker bundle（ESM，含 core-api + Stalwart 适配器 + 安全头）。 */
  coreWorker: string;
  /** core 迁移目录（services/core-api/migrations/core 的产物副本）。 */
  coreMigrationsDir: string;
  /** 平台基建迁移目录（services/core-api/migrations/modules 的产物副本）。 */
  platformMigrationsDir: string;
  /** shell 静态资产（apps/shell/dist 的产物副本）。 */
  shellDir: string;
  /** 随包第三方依赖（blake3-wasm：createRequire 加载，需真实文件树，无法进 bundle）。 */
  vendorDir: string;
}

export interface ArtifactsManifest {
  formatVersion: number;
  /** 安装器版本（packages/installer/package.json version）。 */
  installerVersion?: string;
  /** 产物生成时间（ISO）。 */
  generatedAt?: string;
  /** 生成时 Node 版本（人话排障用）。 */
  node?: string;
}

/** 由产物根路径推全部子路径（纯计算；合法性由 resolveArtifactRoots 判）。 */
export function artifactRootsFrom(root: string): ArtifactRoots {
  const abs = resolvePath(root);
  return {
    root: abs,
    manifestPath: join(abs, 'manifest.json'),
    coreWorker: join(abs, 'core', 'worker.js'),
    coreMigrationsDir: join(abs, 'core', 'migrations', 'core'),
    platformMigrationsDir: join(abs, 'core', 'migrations', 'modules'),
    shellDir: join(abs, 'shell'),
    vendorDir: join(abs, 'vendor'),
  };
}

/** 读产物 manifest（缺文件 / JSON 非法 / formatVersion 不符 → 抛人话错）。 */
export function readArtifactsManifest(root: string): ArtifactsManifest {
  const path = join(resolvePath(root), 'manifest.json');
  if (!existsSync(path)) {
    throw new Error(
      `产物根不合法：${resolvePath(root)} 缺 manifest.json——安装器产物应含 dist/artifacts/manifest.json（formatVersion=${ARTIFACTS_FORMAT_VERSION}）；` +
        '仓库内开发不需要产物根（不要传 artifactRoot / 不要设 UNSELF_ARTIFACTS）',
    );
  }
  let parsed: ArtifactsManifest;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as ArtifactsManifest;
  } catch (err) {
    throw new Error(`产物根不合法：${path} 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`);
  }
  if (parsed.formatVersion !== ARTIFACTS_FORMAT_VERSION) {
    throw new Error(
      `产物根版本不兼容：${path} formatVersion=${String(parsed.formatVersion)}，本引擎只认 ${ARTIFACTS_FORMAT_VERSION}——` +
        '引擎与产物必须同版本发布（升级安装器而不是混用）',
    );
  }
  return parsed;
}

/** 引擎模块目录下的默认产物位置（打包形态：<installer>/dist/unself.mjs → <installer>/dist/artifacts/）。 */
export function defaultArtifactsPath(): string {
  return fileURLToPath(new URL('./artifacts/', import.meta.url));
}

/**
 * 解析产物根：
 * - `artifactRoot` 入参 / `UNSELF_ARTIFACTS` 显式给出 → **必须合法**（非法直接抛）；
 * - 都没有 → 探测 `<引擎模块目录>/artifacts`：命中且合法 → 产物形态；缺失 → null（仓库开发形态）。
 */
export function resolveArtifactRoots(input?: {
  /** 显式产物根（runNineSteps 入参）。 */
  artifactRoot?: string;
  /** 环境变量覆盖（缺省 process.env；测试注入用）。 */
  env?: Record<string, string | undefined>;
  /** rootDir（相对 artifactRoot 的解析基准；缺省 process.cwd()）。 */
  rootDir?: string;
}): ArtifactRoots | null {
  const env = input?.env ?? process.env;
  const explicit = input?.artifactRoot ?? env.UNSELF_ARTIFACTS;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const abs = input?.rootDir ? resolvePath(input.rootDir, explicit) : resolvePath(explicit);
    readArtifactsManifest(abs); // 显式指定必须合法：验证即抛
    return artifactRootsFrom(abs);
  }
  const detected = defaultArtifactsPath();
  if (!existsSync(join(detected, 'manifest.json'))) return null;
  readArtifactsManifest(detected);
  return artifactRootsFrom(detected);
}

/**
 * 当前进程生效的产物根（供 assets.ts 的 blake3 vendor 回落等深层模块取用，不在调用链上再穿参数）。
 * `runNineSteps` 解析后立即登记；未登记时按自探测规则现取。
 */
let activeRoots: ArtifactRoots | null | undefined;

/** 登记本次运行的产物根（runNineSteps 调用；null = 仓库形态）。 */
export function setActiveArtifactRoots(roots: ArtifactRoots | null): void {
  activeRoots = roots;
}

/** 取当前产物根（未登记 → 现探测一次，不缓存失败）。 */
export function activeArtifactRoots(): ArtifactRoots | null {
  if (activeRoots === undefined) {
    activeRoots = resolveArtifactRoots();
  }
  return activeRoots;
}

/** 随包第三方依赖候选路径（blake3-wasm 需要真实文件树：wasm 用 fs 相对路径加载，bundle 会打断）。 */
export function vendoredBlake3Dirs(): string[] {
  const roots = activeArtifactRoots();
  return roots ? [join(roots.vendorDir, 'blake3-wasm')] : [];
}
