// SPDX-License-Identifier: AGPL-3.0-only
import { SignJWT } from 'jose';

import type { Bindings } from './index';
import type { SigningRuntime } from './keys';

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
    caps?: string[];
  };
}

/** 签发上下文：谁（用户）在哪个模块申请 token。 */
export interface TokenRequestContext {
  /** 核心内部用户 id（会话里的 uid）。 */
  userId: string;
  /** 模块 id（路由参数）。 */
  moduleId: string;
}

/**
 * 签发模块 token：
 * - aud = 模块 id（token 不能跨模块重放，§5.2）；
 * - sub = 核心内部稳定用户 id；
 * - exp = 10 分钟；caps = 注册表中该模块授权给用户的能力（M0 先取 manifest.capabilities）。
 * - kid 取签名运行时的 thumbprint，模块经 JWKS 按 kid 选钥验签。
 */
export async function issueModuleToken(
  runtime: SigningRuntime,
  ctx: TokenRequestContext,
  options: { issuer: string; caps?: string[] },
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
  if (options.caps && options.caps.length > 0) {
    payload.caps = options.caps;
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

/** 读取模块 caps（manifest.capabilities）；解析失败返回空。 */
export function capsFromManifest(manifestJson: string): string[] {
  try {
    const manifest = JSON.parse(manifestJson) as { capabilities?: unknown };
    if (Array.isArray(manifest.capabilities)) {
      return manifest.capabilities.filter((c): c is string => typeof c === 'string');
    }
  } catch {
    // 坏 manifest 视为无能力
  }
  return [];
}

// Bindings 仅作类型引用（避免循环 import 时的运行时依赖）
export type { Bindings };
