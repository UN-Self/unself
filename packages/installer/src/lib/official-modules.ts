// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 官方模块目录（决策 #76/#77）：**就是普通 npm 包，没有特权来源通道**。
 *
 * 安装器 `dependencies` 里精确预装了 `@unself/hello` / `@unself/chat`（发布时 pnpm 把
 * `workspace:*` 改写为版本号），所以默认安装串写 npm 串、解析时本地 `node_modules` 命中即零网络。
 * 官方模块与第三方走**同一个解析器、同一套安装与卸载路径**（#77）；本文件只负责「默认值」。
 *
 * 版本来源（单一真源）：`packages/installer/package.json` 的 `dependencies` 声明。
 * 仓库开发形态下声明是 `workspace:*`（拿不到版本号）→ 回落到本地已装包的 package.json version
 * （pnpm workspace 符号链接指向 `modules/<id>`）。两条路都拿不到就抛人话错——**不猜版本**
 * （猜错会静默拉错版本或偷偷联网）。
 *
 * 零引擎依赖（#53：init/逃生门命令不 import 装配引擎），故 node_modules 查找在本文件内实现；
 * 引擎侧同语义实现见 `deploy/cloudflare/src/sources.ts` 的 `findLocalPackageDir`。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 官方模块（id = 实例内建议名；pkg = npm 包名）。 */
export interface OfficialModule {
  id: string;
  pkg: string;
}

/** 对外只发这两个官方模块（决策 #76）。新增官方模块在此登记 + 安装器 dependencies 同步声明。 */
export const OFFICIAL_MODULES: readonly OfficialModule[] = [
  { id: 'hello', pkg: '@unself/hello' },
  { id: 'chat', pkg: '@unself/chat' },
];

/** 向导/`init` 默认勾选的官方模块（决策 #77：默认值不是特权）。 */
export const DEFAULT_MODULE_IDS: readonly string[] = ['hello'];

/** 取官方模块（非官方返回 undefined）。 */
export function officialModuleById(id: string): OfficialModule | undefined {
  return OFFICIAL_MODULES.find((m) => m.id === id);
}

/** 官方模块的安装串：`npm:@unself/<id>@<version>`。 */
export function officialModuleSource(input: { pkg: string; version: string }): string {
  return `npm:${input.pkg}@${input.version}`;
}

/** 从目录向上逐级找 `<ancestor>/node_modules/<pkg>`（Node 解析算法核心部分；同引擎侧语义）。 */
function findLocalPackageDir(pkg: string): string | null {
  const bases = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const base of bases) {
    let dir = base;
    for (;;) {
      const candidate = join(dir, 'node_modules', pkg);
      const pkgJson = join(candidate, 'package.json');
      if (existsSync(pkgJson)) {
        try {
          if ((JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string }).name === pkg) return candidate;
        } catch {
          // 非法 package.json：视同未命中（真坏包会在安装期报人话错）
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** 本包（@unself/installer）的 package.json 路径：从 import.meta.url 向上找同名包。 */
function installerPackageJsonPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        if ((JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }).name === '@unself/installer') {
          return candidate;
        }
      } catch {
        // 继续向上
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    '找不到 @unself/installer 的 package.json（官方模块版本真源）——安装包结构被改坏？重装安装器',
  );
}

/**
 * 官方模块的版本：安装器 `dependencies` 声明的真值。
 * `workspace:*` 等 workspace 协议 → 回落到本地已装包版本（仓库开发形态）。
 */
export function officialModuleVersion(pkg: string): string {
  const pkgJson = JSON.parse(readFileSync(installerPackageJsonPath(), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const spec = pkgJson.dependencies?.[pkg];
  if (!spec) {
    throw new Error(
      `安装器 dependencies 未声明官方模块 ${pkg}（决策 #76：官方模块靠精确预装获得「零网络」）——请修 packages/installer/package.json`,
    );
  }
  if (!spec.startsWith('workspace:')) return spec;
  const localDir = findLocalPackageDir(pkg);
  if (!localDir) {
    throw new Error(
      `官方模块 ${pkg} 声明为 ${spec}，但本地 node_modules 里找不到它——请先 \`pnpm install\``,
    );
  }
  const version = (JSON.parse(readFileSync(join(localDir, 'package.json'), 'utf8')) as { version?: string }).version;
  if (!version) throw new Error(`官方模块 ${pkg} 的 package.json 缺 version：${localDir}`);
  return version;
}

/** 官方模块 → config 条目（`{id, source: npm:…}`）。 */
export function officialModuleEntry(id: string): { id: string; source: string } {
  const mod = officialModuleById(id);
  if (!mod) throw new Error(`不是官方模块：${id}（官方模块只有 ${OFFICIAL_MODULES.map((m) => m.id).join(' / ')}）`);
  return { id: mod.id, source: officialModuleSource({ pkg: mod.pkg, version: officialModuleVersion(mod.pkg) }) };
}

/** 默认启用的模块条目（向导/init 用）：官方模块的 npm 串。 */
export function defaultModuleEntries(): Array<{ id: string; source: string }> {
  return DEFAULT_MODULE_IDS.map((id) => officialModuleEntry(id));
}

/** 官方模块 id 是否在默认目录里。 */
export function isOfficialModule(id: string): boolean {
  return officialModuleById(id) !== undefined;
}
