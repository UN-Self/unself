// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

import themeTokens from './theme-tokens.json';

/**
 * 主题系统契约（PRODUCT_SPEC §6.5.1-6.5.4）：
 * - 三层令牌：primitive（品牌值）→ semantic（平台契约名，模块只引这层）→ component（packages/ui 内部）。
 * - 语义清单「只增不改、不删项」；全部语义令牌前缀 `--unself-`（§6.5.3）。
 * - 主题包 = 「语义名→值」JSON 映射 + JSON Schema；部分覆盖合法，非法值拒绝（§6.5.4）。
 *
 * 键格式：点号语义名（与主题包协议一致，如 'unself.color.primary'）→ CSS 变量名
 * 经 tokenCssName() 单点转换（'--unself-color-primary'）。机器可读的默认主题包
 * 真值在 theme-tokens.json，tokens.css 与之同值并由测试守卫（单一份值，防漂移）。
 */

/** 语义令牌映射：点号语义名 → CSS 值（默认主题包 = 平台内置，§6.5.4 兜底）。 */
export type ThemeTokens = Record<string, string>;

/** 平台内置默认主题包（主题包协议「默认主题包」= 此处，现 tokens.css 的值即其内容）。 */
export const DEFAULT_THEME: ThemeTokens = themeTokens as ThemeTokens;

/** 全部契约令牌名（白名单，只增不改：SPEC 清单之外的名字一律拒绝）。 */
export const THEME_TOKEN_KEYS = Object.keys(DEFAULT_THEME) as [string, ...string[]];

/**
 * 主题令牌映射校验：键必须来自契约白名单（拒绝未知名），值必须是非空字符串。
 * 部分覆盖合法（只出现的键被校验），「非法值拒绝」= 任一键/值非法整体拒绝。
 */
export const ThemeTokensSchema = z
  .record(z.string(), z.string().min(1))
  .superRefine((map, ctx) => {
    const known = new Set(THEME_TOKEN_KEYS);
    for (const key of Object.keys(map)) {
      if (!known.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown theme token "${key}" (contract list is closed, see PRODUCT_SPEC §6.5.2)`,
          path: [key],
        });
      }
    }
  });

export type ThemeTokensValue = z.infer<typeof ThemeTokensSchema>;

/** 主题包协议（§6.5.4）：schemaVersion 带向前兼容；tokens 部分覆盖合法。 */
export const ThemePackageSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  tokens: ThemeTokensSchema,
});

export type ThemePackage = z.infer<typeof ThemePackageSchema>;

/** 解析主题包：schema 校验不过即抛错（部署时红，不静默吞，§6.5.4）。 */
export function parseThemePackage(input: unknown): ThemePackage {
  return ThemePackageSchema.parse(input);
}

/** 主题包 → 生效令牌：部分覆盖合并平台默认（缺省键走默认兜底，§6.5.4）。 */
export function resolveThemePackage(pkg: Pick<ThemePackage, 'tokens'>): ThemeTokens {
  return { ...DEFAULT_THEME, ...pkg.tokens };
}

/** 点号语义名 → CSS 变量名：'unself.color.primary' → '--unself-color-primary'。 */
export function tokenCssName(dotted: string): string {
  if (!dotted.startsWith('unself.')) {
    throw new Error(`theme token name must start with "unself.": ${dotted}`);
  }
  return `--${dotted.replaceAll('.', '-')}`;
}

/** 全部契约令牌的 CSS 变量名（体检/审计白名单，§6.5.3 一条规则全查）。 */
export const THEME_TOKEN_CSS_NAMES: readonly string[] = THEME_TOKEN_KEYS.map(tokenCssName);

/**
 * 提取文本中的全部 var() 引用（去重，保序）。
 * 只认 `var(--xxx` 形态（自定义属性引用）；平台体检/审计据此查未声明引用。
 */
export function extractVarRefs(text: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const re = /var\(\s*(--[a-zA-Z0-9-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      refs.push(name);
    }
  }
  return refs;
}

/** var() 引用体检结果：used = 引用到的全部变量名；unknown = 不在契约白名单的（未解析/裸 var）。 */
export interface TokenUsageAnalysis {
  /** 页面引用的全部 var(--xxx) 名（去重）。 */
  used: string[];
  /** 不在契约白名单的引用（平台永不提供值 → 未解析，§6.5.8 红）。 */
  unknown: string[];
}

/** 分析文本（模块页 HTML / 源码）中的 var() 引用是否全部在契约白名单。 */
export function analyzeTokenUsage(text: string): TokenUsageAnalysis {
  const used = extractVarRefs(text);
  const nameSet = new Set(THEME_TOKEN_CSS_NAMES);
  return {
    used,
    unknown: used.filter((name) => !nameSet.has(name)),
  };
}
