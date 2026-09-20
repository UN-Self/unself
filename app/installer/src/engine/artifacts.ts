// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 平台产物解析（#303 修订 #257 口径）：**平台产物随 `@unself/workbench` 包发布**，安装器只是它的消费者。
 *
 * 修订前：产物由安装器构建期嵌进 `dist/artifacts/**`（installer tarball 3.7MB，其中产物 2.5MB），
 * 引擎在「产物形态 / 仓库形态」之间二选一（两套行为）。
 * 修订后：`@unself/workbench` 是安装器的普通依赖（与官方模块同一条 `localPackageDir` 解析，#284 单一实现），
 * 引擎读包内预构建产物——**只有一条路径**，仓库形态与安装形态同源（都读 workbench 的 `dist/`）。
 *
 * 产物布局（workbench 包内，见 app/workbench/{package.json,scripts/build-worker.ts,vite.config.ts}）：
 * ```
 * <workbench>/dist/worker.js        预打包 core Worker bundle（含 Stalwart 适配器 + 安全头）
 * <workbench>/dist/web/**           壳静态资产（vite 产物，含 _headers）
 * <workbench>/migrations/core/*.sql core 迁移 SQL
 * <workbench>/migrations/modules/…  平台基建迁移 SQL
 * ```
 *
 * 判据 = 包目录里 `package.json` 的 `name === '@unself/workbench'`（防同名错包/指错目录）；
 * 目录对但**没构建**（缺 dist）→ 当场报人话错，不静默回落（宁可显式故障，不要伪装）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { localPackageDir } from './sources';

/** 平台产物包名（唯一真值点；装配引擎与测试都用它）。 */
export const WORKBENCH_PACKAGE = '@unself/workbench';

/** 平台产物根（内置判据 = 包名 + dist 产物齐备）。 */
export interface PlatformArtifacts {
  /** workbench 包目录绝对路径。 */
  root: string;
  /** 包版本（日志/排障用）。 */
  version: string;
  /** 预打包 core Worker bundle（ESM，含 app/workbench 的 src 半边 + Stalwart 适配器 + 安全头）。 */
  coreWorker: string;
  /** 壳静态资产目录（dist/web）。 */
  shellDir: string;
  /** core 库迁移目录。 */
  coreMigrationsDir: string;
  /** 平台基建库迁移目录。 */
  platformMigrationsDir: string;
}

/** 由 workbench 包目录推全部子路径（纯计算；合法性由 resolvePlatformArtifacts 判）。 */
export function platformArtifactsFrom(root: string, version = '0.0.0'): PlatformArtifacts {
  const abs = resolvePath(root);
  return {
    root: abs,
    version,
    coreWorker: join(abs, 'dist', 'worker.js'),
    shellDir: join(abs, 'dist', 'web'),
    coreMigrationsDir: join(abs, 'migrations', 'core'),
    platformMigrationsDir: join(abs, 'migrations', 'modules'),
  };
}

/** 读包目录里的 name/version（非包目录 / JSON 非法 → null）。 */
function readPackageName(root: string): { name?: string; version?: string } | null {
  const pkgJson = join(resolvePath(root), 'package.json');
  if (!existsSync(pkgJson)) return null;
  try {
    return JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string; version?: string };
  } catch {
    return null;
  }
}

/** 找不到包 / 包不对 / 没构建 → 人话错（三要素：现象 + 病因 + 下一步）。 */
function packageProblem(dir: string, why: string): Error {
  return new Error(
    `平台产物不可用：${dir} ${why}。` +
      `引擎需要 \`${WORKBENCH_PACKAGE}\` 包内的预构建产物（dist/worker.js + dist/web + migrations/）。` +
      '仓库内开发：先 `pnpm --filter @unself/workbench build`（或 `pnpm -r build`）；' +
      '安装器形态：确认依赖已装上（`npm install` 会带 @unself/workbench）。',
  );
}

/**
 * 解析平台产物（顺序：显式目录 > 包解析）。
 *
 * @param input.rootDir   本地包解析基准（实例目录；找不到时引擎目录向上兜底，见 localPackageDir）
 * @param input.workbenchDir 显式 workbench 包目录（测试 / 嵌入式；给了就必须合法，不做兜底）
 */
export function resolvePlatformArtifacts(input: {
  rootDir: string;
  workbenchDir?: string;
  env?: Record<string, string | undefined>;
}): PlatformArtifacts {
  const explicit = input.workbenchDir ?? (input.env ?? process.env).UNSELF_WORKBENCH_DIR;
  let dir: string;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    dir = resolvePath(input.rootDir, explicit);
    const pkg = readPackageName(dir);
    if (pkg?.name !== WORKBENCH_PACKAGE) {
      throw packageProblem(dir, `不是 ${WORKBENCH_PACKAGE} 包（显式指定的目录必须合法，不做兜底）`);
    }
  } else {
    const found = localPackageDir({ pkg: WORKBENCH_PACKAGE, rootDir: input.rootDir });
    if (found === null) {
      throw packageProblem(
        resolvePath(input.rootDir),
        `下没找到 node_modules/${WORKBENCH_PACKAGE}（包未安装？）`,
      );
    }
    dir = found;
  }

  const version = readPackageName(dir)?.version ?? '0.0.0';
  const artifacts = platformArtifactsFrom(dir, version);
  if (!existsSync(artifacts.coreWorker)) {
    throw packageProblem(dir, '缺 dist/worker.js（包已装但没构建？）');
  }
  if (!existsSync(join(artifacts.shellDir, 'index.html'))) {
    throw packageProblem(dir, '缺 dist/web/index.html（壳产物缺失）');
  }
  if (!existsSync(artifacts.coreMigrationsDir)) {
    throw packageProblem(dir, '缺 migrations/core（迁移 SQL 缺失）');
  }
  return artifacts;
}
