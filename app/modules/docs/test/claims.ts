// SPDX-License-Identifier: AGPL-3.0-only
import type { ModuleTokenClaims } from '@unself/contracts';

/** 造一份合法 claims（字段形状对齐 core 签发的模块 token，#358 §1 契约基座）。 */
export function claims(overrides: Partial<ModuleTokenClaims> = {}): ModuleTokenClaims {
  return {
    iss: 'unself-core',
    sub: 'user-1',
    aud: 'docs',
    iat: 1_700_000_000,
    exp: 1_700_000_600,
    ...overrides,
  };
}
