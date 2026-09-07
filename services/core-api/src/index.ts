// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';

import { deriveSigningRuntime, generateInstanceKeyPair, type SigningRuntime } from './keys';

export interface Bindings {
  CORE_DB: D1Database;
  MODULES_DB: D1Database;
  /** 实例签名私钥（PKCS8 PEM）；由部署/首启流程写入 wrangler secret（#14/#16）。 */
  JWT_PRIVATE_KEY?: string;
}

/** 进程内缓存：同一 PEM 只派生一次（Workers isolate 生命周期内有效）。 */
const runtimeCache = new Map<string, SigningRuntime>();

/** 取当前实例签名运行时；未配置 secret 时返回 null（JWKS 端点回 503）。 */
export async function getSigningRuntime(jwtPrivateKey: string | undefined): Promise<SigningRuntime | null> {
  if (!jwtPrivateKey) {
    return null;
  }
  const cached = runtimeCache.get(jwtPrivateKey);
  if (cached) {
    return cached;
  }
  const runtime = await deriveSigningRuntime(jwtPrivateKey);
  runtimeCache.set(jwtPrivateKey, runtime);
  return runtime;
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/health', (c) => c.json({ ok: true, service: 'core-api' }));

// M0 骨架：租户激活流程尚未实现
app.post('/api/setup/activate', (c) =>
  c.json({ error: 'not implemented (M0 scaffold)' }, 501)
);

// M0 骨架：模块令牌签发尚未实现（#3 实装：用 signingKey 签 ES256 JWT，kid 取 runtime.kid）
app.post('/api/modules/:id/token', (c) =>
  c.json({ error: 'not implemented (M0 scaffold)' }, 501)
);

/** 实例公钥集：模块后端与 SDK 验签的唯一真值来源（§5.2）。 */
app.get('/.well-known/jwks.json', async (c) => {
  const runtime = await getSigningRuntime(c.env?.JWT_PRIVATE_KEY);
  if (!runtime) {
    return c.json({ error: 'signing key not provisioned (run deploy bootstrap)' }, 503);
  }
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(runtime.jwks);
});

// 部署/首启自检：生成新 ES256 密钥对打印给部署者（privateKeyPem → wrangler secret）。
// 进程自身不持 CF 凭证、不落盘（§5.5：装配只在部署时执行）。
app.post('/api/admin/bootstrap-keygen', async (c) => {
  const pair = await generateInstanceKeyPair();
  return c.json({
    hint: '把 privateKeyPem 写入 wrangler secret JWT_PRIVATE_KEY 后重部署；publicKeyPem 备查',
    ...pair,
  });
});

export default app;
