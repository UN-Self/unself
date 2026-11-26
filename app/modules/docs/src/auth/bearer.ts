// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 认证收口（issue #358 · T3 前半）：把请求里的 Bearer 变成 claims，或变成确定的失败。
 *
 * 三条语义在这里一次锁死，端点不许各自实现：
 * 1. 缺 Authorization / 非 Bearer 形态 → 401 `missing_bearer_token`
 * 2. 验签不过（签名不符 / 过期 / aud 不符）→ 401 `token_invalid`，**不区分原因**
 * 3. 本进程拿不到 core 公钥 → 503 `jwks_unavailable`（配置缺口，不冒充 401）
 *
 * 验签器由装配层注入（`createDocsApp({ verifier })`）：公钥是部署期注入的 `CORE_JWKS_JSON`
 * （CF 形态来自 `vars`，node/docker 形态来自进程环境变量，同一变量同一语义——本地验签、
 * 运行时不联网取钥；见安装器 README「Docker 等价注记」）——本文件不关心
 * 公钥从哪来，只关心「拿不到就是 503」。
 */
import type { ModuleTokenClaims } from '@unself/contracts';

import { ERROR_CODES, ERROR_STATUS, errorBody, type ErrorBody, type ErrorCode } from '../errors';

/** 验签器：吃 token 吐 claims，失败抛错（`@unself/sdk` 的 `verifyModuleToken` 即此形状）。 */
export type TokenVerifier = (token: string) => Promise<ModuleTokenClaims>;

/** 认证通过：claims.sub 是核心稳定用户 id，是本模块唯一身份来源。 */
export interface AuthSuccess {
  ok: true;
  claims: ModuleTokenClaims;
}

/** 认证失败：状态码与响应体一起给出，调用方直接回，不再二次判断。 */
export interface AuthFailure {
  ok: false;
  status: number;
  body: ErrorBody;
}

export type AuthOutcome = AuthSuccess | AuthFailure;

/** 取 Bearer 令牌；非法/缺失一律 null（scheme 大小写不敏感，RFC 7235）。 */
export function readBearer(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const [scheme, ...rest] = authorization.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token === '' ? null : token;
}

function failure(code: ErrorCode): AuthFailure {
  return { ok: false, status: ERROR_STATUS[code], body: errorBody(code) };
}

/**
 * 认证收口。`verifier === null` 表示本进程没有公钥（启动期没拿到）——回 503 而不是
 * 401，否则运维会把配置问题当成用户令牌问题查。
 */
export async function requireAuth(input: {
  authorization: string | undefined;
  verifier: TokenVerifier | null;
}): Promise<AuthOutcome> {
  const token = readBearer(input.authorization);
  if (token === null) return failure(ERROR_CODES.missingBearerToken);
  if (input.verifier === null) return failure(ERROR_CODES.jwksUnavailable);
  try {
    return { ok: true, claims: await input.verifier(token) };
  } catch {
    return failure(ERROR_CODES.tokenInvalid);
  }
}
