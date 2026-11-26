// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import type { ModuleTokenClaims } from '@unself/contracts';
import { verifyModuleToken } from '@unself/sdk';

/** manifest.id，仅本地兜底；部署态用装配器注入的 MODULE_ID。 */
export const DEFAULT_MODULE_ID = 'calendar';

export interface Bindings {
  /** 专属 D1（装配期接线）。 */
  DB: D1Database;
  /** Core 公钥 JWKS（部署期注入，模块本地验签）。 */
  CORE_JWKS_JSON?: string;
  /** Core issuer（可选，非空时校验 iss）。 */
  CORE_ISSUER?: string;
  /** 实例 id 即 aud，装配器部署期注入。 */
  MODULE_ID?: string;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: { claims: ModuleTokenClaims };
};

/** 全模块唯一认证收口：缺 JWKS 503，token 验不过或 aud/iss 不对 401。 */
export async function requireAuth(c: Context<AppEnv>): Promise<Response | null> {
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'missing bearer token' }, 401);
  }
  const coreJwksJson = c.env.CORE_JWKS_JSON;
  if (!coreJwksJson) {
    return c.json({ error: 'jwks not provisioned' }, 503);
  }
  try {
    const claims = await verifyModuleToken(auth.slice(7), {
      coreJwksJson,
      // aud 是实例 id，优先用装配器注入的 MODULE_ID
      audience: c.env.MODULE_ID ?? DEFAULT_MODULE_ID,
    });
    // SDK 只校验 audience，iss 在模块侧补：配了 CORE_ISSUER 就必须对上
    if (c.env.CORE_ISSUER && claims.iss !== c.env.CORE_ISSUER) {
      return c.json({ error: 'token invalid or expired' }, 401);
    }
    c.set('claims', claims);
    return null;
  } catch {
    return c.json({ error: 'token invalid or expired' }, 401);
  }
}
