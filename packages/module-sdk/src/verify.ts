// SPDX-License-Identifier: AGPL-3.0-only
import { ModuleTokenClaimsSchema, type ModuleTokenClaims } from '@unself/contracts';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface VerifyModuleTokenOptions {
  /** Core 的 JWKS 端点（OIDC jwks_uri）。 */
  jwksUrl: string;
  /** 期望 audience（与 ModuleTokenClaims.aud 一致）。 */
  audience: string;
}

/**
 * 模块后端侧校验 Core 签发的模块 token：
 * 远端 JWKS 验签 + audience 校验 + claims schema 解析。
 * audience 不匹配或解析失败均抛错。
 */
export async function verifyModuleToken(
  token: string,
  options: VerifyModuleTokenOptions,
): Promise<ModuleTokenClaims> {
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl));
  const { payload } = await jwtVerify(token, jwks, {
    audience: options.audience,
  });
  return ModuleTokenClaimsSchema.parse(payload);
}
