// SPDX-License-Identifier: AGPL-3.0-only
import { SignJWT, createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';

import { ModuleTokenClaimsSchema, type ModulePermission, type ModuleTokenClaims } from '@unself/contracts';

import type { Bindings } from './index';
import { getSigningRuntime, type Jwks, type SigningRuntime } from './keys';

/** 模块 token 有效期（秒）：§5.2 拍板 10 分钟 + 静默续期。 */
export const MODULE_TOKEN_TTL_SECONDS = 10 * 60;

/** 模块 token 的 iss 标识（Core 自称；模块侧只验签不检查 iss 值）。 */
export const MODULE_TOKEN_ISSUER = 'unself-core';

/** token 签发结果（响应体）。 */
export interface IssuedModuleToken {
  /** 签好的 ES256 JWT。 */
  token: string;
  /** 有效期（秒），SDK 据此安排静默续期。 */
  expiresIn: number;
  /** token claims（调试/展示用，SDK decodeContext 同形状）。 */
  claims: {
    iss: string;
    sub: string;
    aud: string;
    iat: number;
    exp: number;
    name?: string;
  };
}

/** 签发上下文：谁（用户）在哪个模块申请 token。 */
export interface TokenRequestContext {
  /** 核心内部用户 id（会话里的 uid）。 */
  userId: string;
  /** 模块 id（路由参数）。 */
  moduleId: string;
  /** 会话展示名（写进 claims.name，模块身份行直接用；§2 契约）。 */
  name?: string;
}

/**
 * 签发模块 token：
 * - aud = 模块 id（token 不能跨模块重放，§5.2）；
 * - sub = 核心内部稳定用户 id；
 * - exp = 10 分钟。
 *   #56：不再签 caps 能力清单——权限改为服务端门禁（core-api /api/module-api/* 按
 *   manifest.permissions 放行/403），token 只证明「谁在访问哪个模块」。
 * - kid 取签名运行时的 thumbprint，模块经 JWKS 按 kid 选钥验签。
 */
export async function issueModuleToken(
  runtime: SigningRuntime,
  ctx: TokenRequestContext,
  options: { issuer: string },
): Promise<IssuedModuleToken> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + MODULE_TOKEN_TTL_SECONDS;
  const payload: Record<string, unknown> = {
    iss: options.issuer,
    sub: ctx.userId,
    aud: ctx.moduleId,
    iat: now,
    exp,
  };
  if (ctx.name !== undefined) {
    payload.name = ctx.name;
  }
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: runtime.kid })
    .sign(runtime.signingKey);
  return {
    token,
    expiresIn: MODULE_TOKEN_TTL_SECONDS,
    claims: payload as IssuedModuleToken['claims'],
  };
}

/** token 门禁检查结果。 */
export interface TokenGateResult {
  ok: boolean;
  /** 拒绝原因（ok=false 时给 HTTP 状态码与人话）。 */
  status?: number;
  error?: string;
  /** 通过时附注册表行。 */
  manifest?: { id: string; enabled: number; manifest_json: string };
}

/**
 * token 门禁：模块必须存在且 enabled（注册表开关 + token 门禁，§5.5）。
 * 成员权限（M1 权限模型）在 M0 先放行全部已启用模块成员。
 */
export async function checkTokenGate(db: D1Database, moduleId: string): Promise<TokenGateResult> {
  const row = await db
    .prepare('SELECT id, enabled, manifest_json FROM module_registry WHERE id = ?')
    .bind(moduleId)
    .first<{ id: string; enabled: number; manifest_json: string }>();
  if (!row) {
    return { ok: false, status: 404, error: 'module not found' };
  }
  if (!row.enabled) {
    return { ok: false, status: 403, error: 'module disabled' };
  }
  return { ok: true, manifest: row };
}

/**
 * 验模块 token 签名与 iss（aud 校验交给调用方按需收紧；这里是「真 Core 签发」级验证）。
 * 本地 JWKS 验签、零运行时网络：密钥真值与本实例 JWKS 端点同源（getSigningRuntime），
 * 模块侧外部验签仍走 /.well-known/jwks.json。验签/解析失败一律 null（不区分原因，不泄露细节）。
 */
export async function verifyModuleToken(
  token: string,
  issuer: string,
  jwks: Jwks,
): Promise<ModuleTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks as unknown as JSONWebKeySet), {
      issuer,
      algorithms: ['ES256'],
    });
    return ModuleTokenClaimsSchema.parse(payload);
  } catch {
    return null;
  }
}

/** 模块门禁通过后的上下文：谁（模块）带着什么声明在调用。 */
export interface ModuleAuthContext {
  /** 模块 id（= token aud = 注册表主键）。 */
  moduleId: string;
  /** 注册表 manifest 快照里声明的权限（词表成员；门禁判定输入）。 */
  permissions: ModulePermission[];
}

/** 模块门禁写入的上下文变量（受保护处理器可读 moduleId / permissions）。 */
export interface ModuleAuthVariables {
  moduleAuth: ModuleAuthContext;
}

/** 模块门禁结果。 */
export type ModuleGate =
  | { ok: true; auth: ModuleAuthContext }
  | { ok: false; status: 401 | 403 | 404 | 503; error: string };

/**
 * 模块门禁本体（决策 #56 的服务端真值）：
 * Bearer 模块 token → 验签（本实例密钥）→ 模块存在且 enabled → 读 manifest 快照的 permissions。
 * 「未声明即调用对应 Core API → 403」的判定输入就来自这里的 permissions。
 */
export async function checkModuleGate(
  db: D1Database,
  secret: string | undefined,
  request: { header(name: 'Authorization'): string | undefined },
): Promise<ModuleGate> {
  if (!secret) {
    return { ok: false, status: 503, error: 'signing key not provisioned (run deploy bootstrap)' };
  }
  const header = request.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'module token required (Authorization: Bearer)' };
  }
  const runtime = await getSigningRuntime(secret);
  if (!runtime) {
    return { ok: false, status: 503, error: 'signing key not provisioned (run deploy bootstrap)' };
  }
  const claims = await verifyModuleToken(header.slice(7), MODULE_TOKEN_ISSUER, runtime.jwks);
  if (!claims) {
    return { ok: false, status: 401, error: 'invalid module token' };
  }
  const row = await db
    .prepare('SELECT enabled, manifest_json FROM module_registry WHERE id = ?')
    .bind(claims.aud)
    .first<{ enabled: number; manifest_json: string }>();
  if (!row) {
    return { ok: false, status: 404, error: 'module not found' };
  }
  if (!row.enabled) {
    return { ok: false, status: 403, error: 'module disabled' };
  }
  let permissions: ModulePermission[] = [];
  try {
    const manifest = JSON.parse(row.manifest_json) as { permissions?: unknown };
    if (Array.isArray(manifest.permissions)) {
      permissions = manifest.permissions.filter((p): p is ModulePermission => typeof p === 'string');
    }
  } catch {
    // 坏 manifest 快照视为无声明（一切受门禁保护的调用都 403，由注册时 validate 拦截这种状态）
  }
  return { ok: true, auth: { moduleId: claims.aud, permissions } };
}

/** Bindings 仅作类型引用（避免循环 import 时的运行时依赖） */
export type { Bindings };
