// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 主题注入（挂载前置）：/api/meta 的 themeVars（唯一真源 = core/contracts theme-tokens.json）
 * 在 app 挂载**之前**写进 <style id="unself-theme-vars">——令牌先就位，样式与 v-motion 的
 * 运行时解析才有值；失败时页面给出明确反馈（不静默白样式）。
 */
export const THEME_STYLE_ID = 'unself-theme-vars';

export interface ThemeLoadResult {
  ok: boolean
  /** 注入的令牌对数（ok=false 时 0）。 */
  count: number
  /** 失败时的人话原因（ok=true 为空串）。 */
  problem: string
}

/** 统计 themeVars 里的令牌对（--xxx: value; 计数）。 */
export function countThemeVars(themeVars: string): number {
  return [...themeVars.matchAll(/--[a-zA-Z0-9-]+\s*:/g)].length;
}

/** 把 themeVars 注入为全局 <style>；重复调用替换内容（幂等）。返回令牌对数。 */
export function injectThemeVars(themeVars: string): number {
  let style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `:root { ${themeVars} }`;
  return countThemeVars(themeVars);
}

/** 拉取并注入主题；失败/空令牌都算失败（返回人话 problem，由入口渲染反馈）。 */
export async function loadTheme(fetchImpl: typeof fetch = fetch): Promise<ThemeLoadResult> {
  try {
    const res = await fetchImpl('/api/meta');
    if (!res.ok) {
      return { ok: false, count: 0, problem: `主题加载失败：/api/meta 返回 HTTP ${res.status}` };
    }
    const meta = (await res.json()) as { tokenDeepLink?: string; themeVars?: string };
    const themeVars = meta.themeVars ?? '';
    const count = injectThemeVars(themeVars);
    if (count === 0) {
      return { ok: false, count: 0, problem: '主题加载失败：/api/meta 未返回任何 --unself-* 令牌（安装器包不完整或版本过旧）' };
    }
    return { ok: true, count, problem: '' };
  } catch (err) {
    return {
      ok: false,
      count: 0,
      problem: `主题加载失败：连不上本地向导服务（${err instanceof Error ? err.message : String(err)}）`,
    };
  }
}
