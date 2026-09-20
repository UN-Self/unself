// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `@unself/sdk` 公开导出面行为测试（issue #283 A2）：
 * 断言「模块作者能拿到什么」，不测实现——删掉任一具名导出或类型即红。
 */
import { describe, expect, it } from 'vitest';

import * as sdk from '../src/index';
import type {
  CreateModuleSDKOptions,
  ModuleSDK,
  ModuleStorage,
  ModuleTokenClaims,
  ThemeTokens,
  VerifyModuleTokenOptions,
} from '../src/index';

describe('@unself/sdk 公开导出面（#283 A2）', () => {
  it('全部具名值导出可用', () => {
    expect(typeof sdk.createModuleSDK).toBe('function');
    expect(typeof sdk.createCoreApiStorage).toBe('function');
    expect(typeof sdk.createModuleStorage).toBe('function');
    expect(typeof sdk.createD1Storage).toBe('function');
    expect(typeof sdk.verifyModuleToken).toBe('function');
    expect(typeof sdk.createModuleApi).toBe('function');
    expect(typeof sdk.resolveShellOrigin).toBe('function');
    expect(typeof sdk.SHELL_ORIGIN_META_NAME).toBe('string');
    expect(sdk.SHELL_ORIGIN_META_NAME).toBe('unself-shell-origin');
    expect(typeof sdk.tokenCssName).toBe('function');
  });

  it('全部公开类型可解析（编译期；运行期仅确认参照值可用）', () => {
    const moduleSdk: ModuleSDK | undefined = undefined;
    const options: CreateModuleSDKOptions | undefined = undefined;
    const verifyOptions: VerifyModuleTokenOptions | undefined = undefined;
    const storage: ModuleStorage | undefined = undefined;
    const tokens: ThemeTokens = {};
    const claims: ModuleTokenClaims | undefined = undefined;
    expect([moduleSdk, options, verifyOptions, storage, claims]).toBeDefined();
    expect(tokens).toEqual({});
  });
});
