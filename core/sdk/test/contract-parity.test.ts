// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 公开结构类型 ↔ `@unself/contracts` 双向一致性（issue #283 漂移守卫）。
 *
 * `src/contract-types.ts` 是契约类型的**结构镜像**（为了让发布 .d.ts 自包含，
 * 第三方不必安装 @unself/contracts）。本测试在 `pnpm -r typecheck` 下双向校对：
 * 任一侧形状变化即编译失败——镜像不能悄悄漂移。
 */
import { describe, expectTypeOf, it } from 'vitest';
import { ModuleConfigSchema as ContractModuleConfigSchema, ModuleManifestSchema as ContractModuleManifestSchema } from '@unself/contracts';
import type {
  ModuleManifest as ContractModuleManifest,
  ModulePermission as ContractModulePermission,
  ModuleTokenClaims as ContractModuleTokenClaims,
  ThemeTokens as ContractThemeTokens,
} from '@unself/contracts';

import type {
  ModuleConfigField,
  ModuleManifest,
  ModulePermission,
  ModuleTokenClaims,
  ThemeTokens,
} from '../src/index';

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

describe('#294 manifest 公开结构镜像与契约一致', () => {
  it('ModuleManifest 双向可赋值（漂移即编译失败）', () => {
    expectTypeOf<ModuleManifest>().toMatchTypeOf<ContractModuleManifest>();
    expectTypeOf<ContractModuleManifest>().toMatchTypeOf<ModuleManifest>();
  });

  it('ModulePermission 双向可赋值（词表成员不漂移）', () => {
    expectTypeOf<ModulePermission>().toMatchTypeOf<ContractModulePermission>();
    expectTypeOf<ContractModulePermission>().toMatchTypeOf<ModulePermission>();
  });

  it('ModuleConfigField 双向可赋值（经契约 schema parse 返回类型推导，不引 zod）', () => {
    // 用值调用的返回类型驱动推断：SDK 无 zod 依赖，不 import zod；
    // 契约 schema 元素形状漂移（如新增必填字段）即此断言编译失败。
    const contractFields = ContractModuleConfigSchema.parse([]);
    expectTypeOf<ModuleConfigField>().toMatchTypeOf<(typeof contractFields)[number]>();
    expectTypeOf<(typeof contractFields)[number]>().toMatchTypeOf<ModuleConfigField>();
  });

  it('公开 ManifestSchema 方法面接受契约 schema（不靠断言，结构性赋值）', () => {
    // 契约 schema 可直接赋给公开方法面——schema 形状漂移（如丢 safeParse）即编译失败
    expectTypeOf<typeof ContractModuleManifestSchema>().toMatchTypeOf<{
      parse(input: unknown): ModuleManifest;
      safeParse(input: unknown): { success: boolean };
    }>();
  });
});
