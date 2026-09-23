// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 向导主题变量（唯一真源 = `core/contracts/src/theme-tokens.json` 的契约默认主题）：
 * 生成 `--unself-*: value` CSS 块，/api/meta 下发给 SPA（值只在运行时出现，源码零字面量色值——
 * verify-tokens 规则照过）。样式一律引用 var(--unself-*)，照 AGENTS「样式只走 tokens」。
 */
import { DEFAULT_THEME, tokenCssName } from '@unself/contracts';

export function themeVarBlock(): string {
  return Object.entries(DEFAULT_THEME)
    .map(([dotted, value]) => `${tokenCssName(dotted)}: ${value};`)
    .join(' ');
}
