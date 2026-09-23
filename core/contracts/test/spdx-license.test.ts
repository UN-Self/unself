// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SPDX 表达式形状校验（issue #292）——行为测试。
 *
 * 边界（docs/modules.md §7 「license 形状」与 issue #292）：
 * - **形状**而非**拼写**：只拒绝语法上不成立的表达式，不查 SPDX License List——
 *   `mitten` / `NotALicense` / `2020` 形状合法即通过（是不是真许可证由列表裁决）。
 * - 语法依据 SPDX v2.3 Annex D（详见 ../src/spdx.ts 注释）。
 *
 * 这些断言测的是「什么形状能过 / 什么形状必拒」的业务边界，不是实现细节：
 * 换一套解析实现（正则、库、查表）只要边界不变，测试不改。
 */
import { describe, expect, it } from 'vitest';

import { isValidSpdxExpression } from '../src/spdx';

describe('isValidSpdxExpression：合法形状通过', () => {
  it.each([
    'MIT',
    'Apache-2.0',
    'AGPL-3.0-only',
    'BSD-3-Clause',
    'LGPL-2.1-or-later',
    // license-id"+"（`+` 紧跟，无空白）
    'GPL-2.0+',
    // 复合表达式
    'MIT OR Apache-2.0',
    'MIT AND Apache-2.0',
    '(MIT OR Apache-2.0) AND BSD-3-Clause',
    '(MIT)',
    'MIT AND (Apache-2.0 OR GPL-2.0+)',
    // WITH 例外
    'GPL-2.0-only WITH Classpath-exception-2.0',
    '(MIT OR GPL-2.0-only) WITH Classpath-exception-2.0',
    // 用户自定义引用
    'LicenseRef-Proprietary',
    'LicenseRef-Acme.1-2',
    'DocumentRef-acme:LicenseRef-internal',
    // 标识符大小写不敏感（形状层不裁决拼写：小写形态合法）
    'mit',
    'mit OR apache-2.0',
  ])('通过：%s', (expr) => {
    expect(isValidSpdxExpression(expr)).toBe(true);
  });

  it('不查表：语法成立但不在 SPDX License List 上的标识符形状合法即通过', () => {
    // 形状层职责边界——「查表」不在本 issue 范围；此处锁定该边界，防被误当 bug 修掉
    expect(isValidSpdxExpression('mitten')).toBe(true);
    expect(isValidSpdxExpression('NotALicense')).toBe(true);
    expect(isValidSpdxExpression('2020')).toBe(true);
  });
});

describe('isValidSpdxExpression：非法形状必拒', () => {
  it.each([
    ['空串', ''],
    ['纯空白', '   '],
    ['前后空白', ' MIT '],
    ['悬空 AND', 'MIT AND'],
    ['悬空 OR', 'MIT OR'],
    ['悬空 WITH', 'MIT WITH'],
    ['WITH 后无例外', 'MIT WITH '],
    ['操作符缺空格（粘成一词）', 'MIT and Apache-2.0'],
    ['小写操作符（AND/OR/WITH 大小写敏感）', 'MIT or Apache-2.0'],
    ['`+` 前有空格', 'MIT +'],
    ['JSON 引号包裹', '"MIT"'],
    ['单引号包裹', "'MIT'"],
    ['LicenseRef 空 idstring', 'LicenseRef-'],
    ['DocumentRef 空 DocumentRef', 'DocumentRef-:LicenseRef-x'],
    ['DocumentRef 缺 LicenseRef 段', 'DocumentRef-acme:x'],
    ['括号不配对（缺右）', '(MIT'],
    ['括号不配对（缺左）', 'MIT)'],
    ['空括号', '()'],
    ['括号内悬空操作符', '(MIT OR)'],
    ['逗号分隔（非 SPDX 分隔符）', 'MIT, Apache-2.0'],
    ['斜杠分隔（非 SPDX 分隔符）', 'MIT/Apache-2.0'],
    ['制表符分隔（表达式须单行、空白仅 ASCII 空格）', 'MIT\tOR\tApache-2.0'],
    ['换行分隔', 'MIT\nOR MIT'],
    ['idstring 以 `-` 起', '-MIT'],
    ['idstring 以 `.` 起', '.MIT'],
    ['裸 `+`', 'MIT+ +'],
    ['双层 WITH', 'MIT WITH Classpath-exception-2.0 WITH x'],
    ['连续操作符', 'MIT OR OR MIT'],
    ['非 ASCII', '许可证'],
    ['自由文本', 'GNU Public License'],
    ['对象形态的旧式 license', '{type:"MIT"}'],
  ])('拒绝：%s', (_label, expr) => {
    expect(isValidSpdxExpression(expr)).toBe(false);
  });

  it('非 string 输入（null / number / 对象）不抛错、返回 false', () => {
    for (const bad of [null, undefined, 3, {}, ['MIT']]) {
      expect(isValidSpdxExpression(bad)).toBe(false);
    }
  });
});
