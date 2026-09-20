// SPDX-License-Identifier: AGPL-3.0-only
// #217 新增（unself 集成层，非上游件）：模块 JWT 验签收口——替代上游本地会话认证。
// token 形状以 core 签发侧为准（services/core-api/src/token.ts issueModuleToken，基线 2ab19ef）：
// ES256 + kid（RFC7638 指纹）；claims iss='unself-core' / sub=<core users.id> / aud=<模块id> / 10 分钟时效。
// 验签复用 core/sdk/src/verify.ts 的 verifyModuleToken（jose createLocalJWKSet + jwtVerify + 契约解析），不手搓。
import { verifyModuleToken } from '@unself/sdk';

/** aud 锁定：token 不能跨模块重放（§5.2）。红灯验证即临时改此常量。 */
export const AUDIENCE = 'chat';

/**
 * 验证模块 token（HTTP Bearer / ?token= / WS 续期帧共用唯一收口）。
 * 返回 {ok:true, claims} 或 {ok:false, status, message}——不抛错，错误形状与上游 session.js 对齐，
 * 由 middleware.js 决定 v1/非 v1 错误体包装。
 */
export async function verifyAccessToken(env, token) {
  if (!token) {
    return { ok: false, status: 401, message: '请先登录' };
  }

  // CORE_JWKS_JSON 由部署装配期注入（装配引擎 steps；wrangler dev 用 .dev.vars）。
  // 空 = 未配，验证面整体不可用：503 明示，与 app/modules/hello 口径一致。
  if (!env.CORE_JWKS_JSON) {
    return { ok: false, status: 503, message: 'jwks not provisioned' };
  }

  try {
    const claims = await verifyModuleToken(token, {
      coreJwksJson: env.CORE_JWKS_JSON,
      audience: AUDIENCE
    });
    if (env.CORE_ISSUER && claims.iss !== env.CORE_ISSUER) {
      return { ok: false, status: 401, message: '请先登录' };
    }
    return { ok: true, claims };
  } catch {
    // 不回显 jose 细节（对齐 hello：错误文案不含 jose/jwt 字样）。
    return { ok: false, status: 401, message: '请先登录' };
  }
}
