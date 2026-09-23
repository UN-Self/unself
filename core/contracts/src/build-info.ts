// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 构建身份（#287，决策 #80）：让「线上到底跑的哪一版」可自证。
 *
 * 本模块只做**纯解析**——不给任何文件系统 / 进程副作用（构建脚本注入 env 与 git 执行器）。
 * 落点：`@unself/workbench` 构建期写 `dist/build-info.json`，`@unself/installer` 构建期把它
 * 内嵌进 CLI；两边的「commit 从哪来」必须是同一套规则，否则「产物说的版本」与「CLI 说的版本」
 * 会各说各话——这正是本 issue 要消灭的病。
 *
 * commit 来源优先级（**禁止伪造**）：
 *   1. `GITHUB_SHA`（CI 环境，40 位十六进制）；
 *   2. `git rev-parse HEAD`（本地构建）；
 *   3. 都没有 → **抛错**。绝不静默返回空串或 'unknown'——「未知版本」比「假版本」危险得多。
 */
import { z } from 'zod';

/** 构建身份载荷（构建期写入 build-info.json 的形状）。 */
export const BuildInfoSchema = z.object({
  /** npm 包名（如 `@unself/workbench`）。 */
  package: z.string().min(1),
  /** 包版本（tag 即版本，决策 #79）。 */
  version: z.string().min(1),
  /** 构建时的 commit SHA（40 位十六进制小写）。 */
  commit: z.string().regex(/^[0-9a-f]{40}$/, 'commit 必须是 40 位十六进制 SHA'),
  /** 构建时刻（ISO 8601）。 */
  builtAt: z.string().min(1),
});

export type BuildInfo = z.infer<typeof BuildInfoSchema>;

/** commit 形状（小写 40 位十六进制）。 */
const COMMIT_RE = /^[0-9a-f]{40}$/;

/** git 执行器（构建脚本注入；返回 stdout 原文，失败抛错）。 */
export type GitRunner = () => string;

export interface ResolveBuildCommitOptions {
  /** 环境变量（注入式；读 `GITHUB_SHA`）。 */
  env: Record<string, string | undefined>;
  /** git fallback（缺省 = 无 git 可用；仅在 `GITHUB_SHA` 缺失/非法时调用）。 */
  git?: GitRunner;
}

/**
 * 解析构建 commit。优先级：`GITHUB_SHA` → git → 抛错。
 *
 * 大小写归一：`git` 输出小写，但 `GITHUB_SHA` / 上层环境可能给大写作变体——
 * SHA 是同一个对象，一律 `toLowerCase()` 后比较（本 issue 边界自查第 5 条）。
 * `GITHUB_SHA` 给了但形状不对（短 SHA / 非十六进制）视为**不可信**，落到 git fallback，
 * 而不是把垃圾值当版本发出去。
 */
export function resolveBuildCommit(options: ResolveBuildCommitOptions): string {
  const fromEnv = options.env.GITHUB_SHA?.trim();
  if (fromEnv) {
    const normalized = fromEnv.toLowerCase();
    if (COMMIT_RE.test(normalized)) return normalized;
    // 形状不对：宁可继续找 git，也不把不可信的 SHA 当身份烙印。
  }
  if (options.git) {
    const raw = options.git().trim().toLowerCase();
    if (COMMIT_RE.test(raw)) return raw;
    throw new Error(
      `git rev-parse HEAD 返回的不是 40 位十六进制 SHA：「${raw.slice(0, 60)}」——` +
        '拒绝伪造/截断的 commit（检查 git 版本与仓库状态）',
    );
  }
  throw new Error(
    '拿不到构建 commit：环境没有 GITHUB_SHA，也没有可用的 git（`git rev-parse HEAD`）。' +
      '构建必须在 git 仓库内（或 CI 提供 GITHUB_SHA）——拒绝产出无 commit 的产物（决策 #80：版本可自证）。',
  );
}

/** 组装构建身份载荷（commit 校验交给 schema；builtAt 由调用方给，便于测试与复现）。 */
export function createBuildInfo(input: {
  package: string;
  version: string;
  commit: string;
  builtAt: string;
}): BuildInfo {
  return BuildInfoSchema.parse({ ...input, commit: input.commit.trim().toLowerCase() });
}

/**
 * 解析 build-info.json 文本（构建产物消费方 / 测试用）。
 * 缺字段、commit 空串或形状不对 → 抛错（不返回半成品对象）。
 * commit 大小写归一（与 createBuildInfo 同口径：SHA 是同一个对象）。
 */
export function parseBuildInfo(text: string): BuildInfo {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`build-info.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const candidate =
    raw !== null && typeof raw === 'object' && typeof (raw as { commit?: unknown }).commit === 'string'
      ? { ...raw, commit: ((raw as { commit: string }).commit).trim().toLowerCase() }
      : raw;
  const parsed = BuildInfoSchema.safeParse(candidate);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('；');
    throw new Error(`build-info.json 校验失败（${details}）——产物版本不可自证，拒绝静默放行`);
  }
  return parsed.data;
}
