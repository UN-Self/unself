// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 公开结构类型 ↔ `@unself/contracts` 双向一致性（issue #283 漂移守卫）。
 *
 * `src/contract-types.ts` 是契约类型的**结构镜像**（为了让发布 .d.ts 自包含，
 * 第三方不必安装 @unself/contracts）。本测试在 `pnpm -r typecheck` 下双向校对：
 * 任一侧形状变化即编译失败——镜像不能悄悄漂移。
 */
import { describe, expectTypeOf, it } from 'vitest';
import type {
  ModuleTokenClaims as ContractModuleTokenClaims,
  ThemeTokens as ContractThemeTokens,
} from '@unself/contracts';

import type { ModuleTokenClaims, ThemeTokens } from '../src/index';

describe('#283 公开结构类型与契约一致', () => {
  it('ThemeTokens 双向可赋值', () => {
    expectTypeOf<ThemeTokens>().toMatchTypeOf<ContractThemeTokens>();
    expectTypeOf<ContractThemeTokens>().toMatchTypeOf<ThemeTokens>();
  });

  it('ModuleTokenClaims 双向可赋值', () => {
    expectTypeOf<ModuleTokenClaims>().toMatchTypeOf<ContractModuleTokenClaims>();
    expectTypeOf<ContractModuleTokenClaims>().toMatchTypeOf<ModuleTokenClaims>();
  });
});
