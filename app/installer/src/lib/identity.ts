// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 安装器身份（#287，决策 #80）：「线上到底跑的哪一版」可自证的三项信息——
 * 安装器版本 + 构建 commit + 平台产物（@unself/workbench）版本。
 * 落点：`unself --version` 与部署收尾屏（`unself deploy` / 向导⑤）共用同一份格式化，
 * 报障可整段粘贴——两处各写一份必然漂移，所以只有这一个真值点。
 *
 * **构建期烙印（方案 A：esbuild `--define`）**：`scripts/build-bin.sh` 构建时把
 * `__UNSELF_INSTALLER_BUILD__` 定义为 `{"version":"…","commit":"…"}` 字面量，bundle 内引用点
 * 在编译期被替换。选 A 不选 B（生成常量模块）的理由：
 *   1. 不产生构建副产物文件——B 需要生成 `src/build-info.generated.ts` 并处理 .gitignore /
 *      构建后清理，脏树状态（构建中断、忘了删）会污染后续构建甚至误提交；
 *   2. define 是 esbuild 原生机制，零额外 IO，产物里只有字面量本身；
 *   3. `scripts/build-info.ts`（tsx）只负责**算出**这份 JSON——commit 解析复用
 *      `@unself/contracts` 的 `resolveBuildCommit`（与 workbench 构建同一套规则：
 *      GITHUB_SHA → git rev-parse HEAD → 抛错，绝不伪造），shell 里不自拼 git 命令。
 *
 * **开发树回退（不经 build-bin.sh 的形态）**：`define` 没发生时全局是 undefined——
 * 本模块回落到「读 app/installer/package.json 的 version + 'dev' 占位 commit」。
 * 决策 #80 禁伪造的是**构建产物**的身份；开发树里跑源码时 commit 随工作区漂移、
 * 本无单一真值，标 'dev' 是诚实的占位（不 crash、不假称某个 SHA）。
 * 测试可通过 `identityLines`/`formatIdentity` 的显式入参注入任意身份（不依赖全局）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** esbuild `--define` 注入的构建期身份（发布产物形态）；开发树 = undefined。 */
declare const __UNSELF_INSTALLER_BUILD__: { version: string; commit: string } | undefined;

/** 安装器自身身份（版本 + commit；commit = 40 位十六进制，开发树为 'dev' 占位）。 */
export interface InstallerIdentity {
  version: string;
  commit: string;
}

/** 读安装器包 package.json 的 version（dist 形态向上一级、源码形态当前目录向上都能命中）。 */
function installerPackageVersion(): string {
  // dist/unself.mjs 运行期 import.meta.dirname = …/app/installer/dist → 向上一级即包根；
  // 源码/tsx 形态 = …/app/installer/src/lib → 需要上两级。两处候选逐个试，判据是包名。
  const base = typeof import.meta.dirname === 'string' ? import.meta.dirname : process.cwd();
  for (const dir of [base, join(base, '..'), join(base, '..', '..')]) {
    if (!existsSync(join(dir, 'package.json'))) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      // 判据 = 包名（防向上误读用户项目/其他包的 package.json）
      if (pkg.name === '@unself/installer' && pkg.version) return pkg.version;
    } catch {
      // package.json 非法 → 继续下一个候选
    }
  }
  return 'unknown';
}

/**
 * 安装器自身身份：构建期烙印优先（发布产物 = 不可变事实）；没有烙印（开发树跑源码）
 * 回落读包 package.json + 'dev' 占位 commit——不 crash、不伪造 SHA。
 */
export function installerIdentity(): InstallerIdentity {
  // esbuild define 在发布产物里替换为字面量；typeof 判定兼容「未 define」的开发形态。
  if (typeof __UNSELF_INSTALLER_BUILD__ !== 'undefined' && __UNSELF_INSTALLER_BUILD__) {
    return { version: __UNSELF_INSTALLER_BUILD__.version, commit: __UNSELF_INSTALLER_BUILD__.commit };
  }
  return { version: installerPackageVersion(), commit: 'dev' };
}

/**
 * 平台产物（@unself/workbench）版本——**轻路径**：只定位包并读 package.json 的 version，
 * **不走 `resolvePlatformArtifacts`**。取舍理由：`resolvePlatformArtifacts` 的契约是「产物齐备
 * 才可用」（强制校验 dist/worker.js + dist/web/index.html + migrations/），那是**装配引擎**
 * 的入门口径——引擎拿不到完整产物就无法装配，抛人话错是对的。但 `--version` 的语义是
 * 「报告身份」，不是「验证可装配」：干净机器上刚 `npm i -g @unself/installer` 还没装好
 * workbench 产物（甚至 npm 尚未解压完 dist）时，`--version` 也必须能用——这正是 #287
 * 复现的现状（`--version` 报「未知命令」）。定位复用引擎的 `localPackageDir`（#284 单一实现，
 * 决策 #87：按包名解析，不硬编码目录），找不到包/读不到版本 → 返回 null，由调用方决定占位文案。
 */
export async function resolveWorkbenchVersion(input: { rootDir: string }): Promise<string | null> {
  // 惰性动态加载：cli 顶部零引擎依赖纪律（装配引擎仅按需加载），只有走版本解析这一条路才 import。
  const { localPackageDir } = await import('../engine/sources');
  const dir = localPackageDir({ pkg: '@unself/workbench', rootDir: input.rootDir });
  if (dir === null) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** 身份三行的稳定形状（测试与两处输出共用；行内自带标签，可复制）。 */
export function identityLines(input: {
  installer: InstallerIdentity;
  workbenchVersion: string | null;
  /** 平台产物解析失败原因（有原因带原因，没原因给默认描述——不静默留空）。 */
  workbenchProblem?: string;
}): string[] {
  return [
    `unself 版本：v${input.installer.version}（commit ${input.installer.commit}）`,
    input.workbenchVersion !== null
      ? `平台产物：@unself/workbench v${input.workbenchVersion}`
      : `平台产物不可用：@unself/workbench（${input.workbenchProblem ?? '包未安装或版本不可读'}）`,
  ];
}

/** 便捷封装：identityLines 的单字符串形态（收尾屏 / SSE 一条消息用）。 */
export function formatIdentity(input: {
  installer: InstallerIdentity;
  workbenchVersion: string | null;
  workbenchProblem?: string;
}): string {
  return identityLines(input).join('\n');
}

/**
 * 解析 + 格式化一条龙（#287）：`unself --version`、`unself deploy` 收尾屏、向导⑤ 完成屏
 * 三处共用的唯一出口——再添第四处也必须走这里，防止格式漂移。
 * 解析失败（包未装 / IO 异常）不抛不静默留空：占位行带原因。
 */
export async function resolveIdentityLines(input: { rootDir: string }): Promise<string[]> {
  const installer = installerIdentity();
  let workbenchVersion: string | null = null;
  let problem: string | undefined;
  try {
    workbenchVersion = await resolveWorkbenchVersion({ rootDir: input.rootDir });
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  return identityLines({
    installer,
    workbenchVersion,
    ...(problem !== undefined ? { workbenchProblem: problem } : {}),
  });
}

/** 解析 + 逐行打印（#287）：`--version` / 部署收尾屏的文本输出形态。 */
export async function reportIdentity(input: { rootDir: string; log: (line: string) => void }): Promise<void> {
  for (const line of await resolveIdentityLines({ rootDir: input.rootDir })) {
    input.log(line);
  }
}
