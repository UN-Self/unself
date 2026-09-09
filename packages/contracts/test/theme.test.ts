// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME,
  THEME_TOKEN_CSS_NAMES,
  THEME_TOKEN_KEYS,
  ThemePackageSchema,
  analyzeTokenUsage,
  parseThemePackage,
  resolveThemePackage,
  tokenCssName,
  type ThemeTokens,
} from '../src/theme';

/** SPEC §6.5.2 语义令牌清单（锁死「只增不改」；真值在 docs/PRODUCT_SPEC.md，此处为契约镜像）。 */
const SPEC_COLORS = [
  'bg', 'surface', 'surface-hover', 'surface-active', 'border', 'text', 'text-secondary',
  'text-tertiary', 'primary', 'primary-hover', 'primary-soft', 'danger', 'danger-soft',
  'success', 'info', 'warning', 'scrim',
] as const;
const SPEC_SPACES = ['1', '2', '3', '4', '5', '6', '8'] as const;
const SPEC_RADII = ['sm', 'md', 'lg', 'full'] as const;
const SPEC_FONT_SIZES = ['xs', 'sm', 'base', 'lg', 'xl', '2xl'] as const;
const SPEC_SHADOWS = ['card', 'pop'] as const;
const SPEC_OTHER = ['focus-ring'] as const;

function specKeys(): string[] {
  return [
    ...SPEC_COLORS.map((n) => `unself.color.${n}`),
    ...SPEC_SPACES.map((n) => `unself.space.${n}`),
    ...SPEC_RADII.map((n) => `unself.radius.${n}`),
    ...SPEC_FONT_SIZES.map((n) => `unself.font-size.${n}`),
    ...SPEC_SHADOWS.map((n) => `unself.shadow.${n}`),
    ...SPEC_OTHER.map((n) => `unself.${n}`),
  ];
}

describe('主题包协议（§6.5.4）', () => {
  it('合法部分覆盖：只写自己的键，parse 通过', () => {
    const pkg = parseThemePackage({
      schemaVersion: 1,
      name: 'handywote-brand',
      tokens: { 'unself.color.primary': '#0f62fe', 'unself.radius.md': '6px' },
    });
    expect(pkg.name).toBe('handywote-brand');
    expect(pkg.tokens).toEqual({ 'unself.color.primary': '#0f62fe', 'unself.radius.md': '6px' });
  });

  it('部分覆盖解析 = 默认主题包上合并覆盖（未写键走默认兜底）', () => {
    const resolved = resolveThemePackage({
      tokens: { 'unself.color.primary': '#0f62fe' },
    });
    expect(resolved['unself.color.primary']).toBe('#0f62fe');
    // 默认兜底：语义清单全部键都在生效集中，无一缺省（模块永远拿得到值）
    expect(Object.keys(resolved).sort()).toEqual([...THEME_TOKEN_KEYS].sort());
    expect(resolved['unself.space.4']).toBe(DEFAULT_THEME['unself.space.4']);
  });

  it('非法值拒绝（1）：契约白名单之外的令牌键 → parse 拒绝', () => {
    expect(() =>
      parseThemePackage({
        schemaVersion: 1,
        name: 'bad',
        tokens: { 'unself.color.nope': '#123456' },
      }),
    ).toThrow(/unknown theme token/);
  });

  it('非法值拒绝（2）：非字符串值 → 拒绝（含空串）', () => {
    for (const bad of [5, null, {}, true, '']) {
      expect(() =>
        parseThemePackage({ schemaVersion: 1, name: 'bad', tokens: { 'unself.color.primary': bad } }),
      ).toThrow();
    }
  });

  it('非法值拒绝（3）：缺 schemaVersion / schemaVersion≠1 / 缺 name / tokens 非对象 → 拒绝', () => {
    expect(() => parseThemePackage({ name: 'x', tokens: {} })).toThrow();
    expect(() => parseThemePackage({ schemaVersion: 2, name: 'x', tokens: {} })).toThrow();
    expect(() => parseThemePackage({ schemaVersion: 1, tokens: {} })).toThrow();
    expect(() => parseThemePackage({ schemaVersion: 1, name: 'x' })).toThrow();
    expect(() => parseThemePackage({ schemaVersion: 1, name: 'x', tokens: [] })).toThrow();
  });

  it('空 tokens 是合法的部分覆盖（极端：全走默认）', () => {
    const resolved = resolveThemePackage(parseThemePackage({ schemaVersion: 1, name: 'plain', tokens: {} }));
    expect(resolved).toEqual(DEFAULT_THEME);
  });
});

describe('默认主题包 = SPEC §6.5.2 清单逐项一致（只增不改铁律）', () => {
  it('键集合与 SPEC 语义清单完全一致（多一个少一个都红）', () => {
    expect([...THEME_TOKEN_KEYS].sort()).toEqual(specKeys().sort());
  });

  it('全部令牌都有非空值（兜底主题包无空洞）', () => {
    for (const [key, value] of Object.entries(DEFAULT_THEME)) {
      expect(value, key).toBeTruthy();
      expect(typeof value).toBe('string');
    }
  });

  it('CSS 变量名 = --unself- 前缀（§6.5.3 命名空间），与键变换一一对应', () => {
    expect(new Set(THEME_TOKEN_CSS_NAMES)).toEqual(
      new Set(THEME_TOKEN_KEYS.map((k) => `--${k.replaceAll('.', '-')}`)),
    );
    expect(THEME_TOKEN_CSS_NAMES.every((n) => n.startsWith('--unself-'))).toBe(true);
  });
});

describe('tokens.css ↔ 默认主题包同值（唯一一次改名窗口后不再漂移）', () => {
  it('tokens.css 的 :root 令牌全部 --unself- 前缀，且契约令牌值与默认包逐项一致', async () => {
    const css = await readFile(
      new URL('../../../apps/shell/src/tokens.css', import.meta.url),
      'utf8',
    );
    // 只取 :root 块（@theme inline 块是 Tailwind 命名空间映射：--color-x: var(--unself-*) 允许存在）
    const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1];
    expect(rootBlock, 'tokens.css 必须存在 :root 令牌块').toBeTruthy();
    // 1) 无历史遗留的非前缀自定义属性（--color-bg 等必须消失）
    const props = [...rootBlock!.matchAll(/--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => ({
      name: `--${m[1]!}`,
      value: m[2]!.trim(),
    }));
    expect(props.length).toBeGreaterThan(0);
    const nonPrefixed = props.filter((p) => !p.name.startsWith('--unself-'));
    expect(nonPrefixed).toEqual([]);

    // 2) 契约令牌（默认包键集）在 tokens.css 中逐一声明且值相同
    const cssMap = new Map(props.map((p) => [p.name, p.value]));
    for (const key of THEME_TOKEN_KEYS) {
      const cssName = tokenCssName(key);
      expect(cssMap.get(cssName), `${cssName} 缺失或值漂移`).toBe(DEFAULT_THEME[key]);
    }
  });
});

describe('tokenCssName', () => {
  it('点号语义名 → --unself- 前缀 CSS 变量名', () => {
    expect(tokenCssName('unself.color.primary')).toBe('--unself-color-primary');
    expect(tokenCssName('unself.font-size.2xl')).toBe('--unself-font-size-2xl');
    expect(tokenCssName('unself.focus-ring')).toBe('--unself-focus-ring');
  });

  it('非 unself. 前缀 → 抛错（白名单外名字永远走不到 CSS 面）', () => {
    expect(() => tokenCssName('color.primary')).toThrow(/must start with "unself\."/);
  });
});

describe('var() 引用体检（§6.5.8 未解析即红）', () => {
  it('提取去重后的 var(--xxx) 引用', () => {
    const text = `
      .a { color: var(--unself-color-primary); }
      .b { gap: var(--unself-space-4); color: var(--unself-color-primary); }
    `;
    const { used, unknown } = analyzeTokenUsage(text);
    expect(used).toEqual(['--unself-color-primary', '--unself-space-4']);
    expect(unknown).toEqual([]);
  });

  it('非契约名（遗留 --color-* / --unself- 拼错）→ unknown 红', () => {
    const { unknown } = analyzeTokenUsage(`
      .legacy { color: var(--color-primary); }
      .typo { gap: var(--unself-space4); }
    `);
    expect(unknown).toEqual(['--color-primary', '--unself-space4']);
  });

  it('零引用 → used 为空（独立皮肤：体检标注不红，§6.5.8）', () => {
    const { used, unknown } = analyzeTokenUsage('<style>.x{color:red}</style>');
    expect(used).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('非 var 形态的 --xxx 声明不误判为引用', () => {
    const { used } = analyzeTokenUsage(':root { --unself-color-bg: #fff; }');
    expect(used).toEqual([]);
  });
});

/** 样例主题包（测试 fixture：值来自默认包与主题包协议示例）。 */
const FIXTURE_PACKAGE = {
  schemaVersion: 1,
  name: 'handywote-brand',
  tokens: { 'unself.color.primary': '#0f62fe' } as ThemeTokens,
};

void FIXTURE_PACKAGE;
void ThemePackageSchema;
