// SPDX-License-Identifier: AGPL-3.0-only
import { tokenCssName as contractTokenCssName } from '@unself/contracts';

/**
 * 主题语义名 → CSS 变量名单点转换（§6.5.3）：帮助模块作者写样式时把语义名
 * （如 `'unself.color.primary'`）转成 `var()` 用的名字（如 `'--unself-color-primary'`）。
 *
 * 本地再导出：契约值在构建期内联，公开签名只引用本包自带的函数类型——
 * 发布产物（含 `.d.ts`）不引用契约包（issue #283 A4/A3）。
 */
export const tokenCssName: (dotted: string) => string = contractTokenCssName;
