// SPDX-License-Identifier: AGPL-3.0-only
import { ModuleTokenClaimsSchema } from '@unself/contracts';
import { createLocalJWKSet, jwtVerify } from 'jose';

// 公开返回类型取本地结构镜像（#283）：保证 d.ts 自包含（见 contract-types.ts）。
import type { ModuleTokenClaims } from './contract-types.js';

export interface VerifyModuleTokenOptions {
  /** Core 公钥 JWKS 的 JSON 序列化（部署期注入，内容 = Core `GET /.well-known/jwks.json` 响应体，§5.2 B 方案）。 */
  coreJwksJson: string;
  /** 期望 audience（与 ModuleTokenClaims.aud 一致）。 */
  audience: string;
}

/**
 * 模块后端侧校验 Core 签发的模块 token：
 * 本地 JWKS 验签（零运行时网络）+ audience 校验 + claims schema 解析。
 * audience 不匹配或解析失败均抛错。
 */
export async function verifyModuleToken(
  token: string,
  options: VerifyModuleTokenOptions,
): Promise<ModuleTokenClaims> {
  const jwks = createLocalJWKSet(JSON.parse(options.coreJwksJson));
  const { payload } = await jwtVerify(token, jwks, {
    audience: options.audience,
  });
  return ModuleTokenClaimsSchema.parse(payload);
}
