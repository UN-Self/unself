// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import {
  buildAuthorizationRequest,
  discover,
  exchangeAuthorizationCode,
  type AuthorizationRequest,
  type OidcClientConfig,
} from './oidc';
import { deriveSigningRuntime, generateInstanceKeyPair, type SigningRuntime } from './keys';
import {
  createSessionToken,
  readSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  type SessionPayload,
} from './session';
import { capsFromManifest, checkTokenGate, issueModuleToken } from './token';

export interface Bindings {
  CORE_DB: D1Database;
  MODULES_DB: D1Database;
  /** 实例签名私钥（PKCS8 PEM）；由部署/首启流程写入 wrangler secret（#14/#16）。 */
  JWT_PRIVATE_KEY?: string;
  /** 开发便利：未跑 setup 时允许环境变量提供 OIDC 配置（生产走 instance_config 表）。 */
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_SCOPE?: string;
}

/** 模块 token 的 iss 标识（Core 自称；模块侧只验签不检查 iss 值）。 */
const MODULE_TOKEN_ISSUER = 'unself-core';

/** 登录流程 Cookie：HttpOnly，10 分钟有效，仅 /api/auth 路径可见。 */
const FLOW_COOKIE = 'unself_oidc_flow';
const FLOW_TTL_SECONDS = 600;

/** 当前请求的对外 origin（redirect_uri/callback 拼接用）。 */
function requestOrigin(url: string): string {
  return new URL(url).origin;
}

/** 进程内缓存：同一 PEM 只派生一次（Workers isolate 生命周期内有效）。 */
const runtimeCache = new Map<string, SigningRuntime>();

/** 取当前实例签名运行时；未配置 secret 时返回 null。 */
async function deriveSigningRuntimeOnce(pem: string): Promise<SigningRuntime> {
  const cached = runtimeCache.get(pem);
  if (cached) return cached;
  const runtime = await deriveSigningRuntime(pem);
  runtimeCache.set(pem, runtime);
  return runtime;
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/health', (c) => c.json({ ok: true, service: 'core-api' }));

/** 当前会话用户（shell 判断登录态 / #10-13 前端用）。 */
app.get('/api/me', async (c) => {
  const session = await readSession(c);
  if (!session) {
    return c.json({ authenticated: false }, 401);
  }
  return c.json({
    authenticated: true,
    user: { id: session.uid, name: session.name, issuer: session.iss, sub: session.sub },
  });
});

// ---------------------------------------------------------------------------
// OIDC 登录（发现 + PKCE + callback + 会话）
// ---------------------------------------------------------------------------

/** 解析登录配置：生产读 instance_config 表（setup 向导写入）；开发可用环境变量兜底。 */
async function getOidcConfig(c: { env: Bindings; req: { url: string } }): Promise<OidcClientConfig | null> {
  let issuer: string | undefined;
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let scope: string | undefined;
  try {
    const rows = await c.env.CORE_DB.prepare(
      'SELECT key, value FROM instance_config WHERE key IN (?, ?, ?, ?)',
    )
      .bind('oidc_issuer', 'oidc_client_id', 'oidc_client_secret', 'oidc_scope')
      .all<{ key: string; value: string }>();
    const map = new Map(rows.results.map((r) => [r.key, r.value]));
    issuer = map.get('oidc_issuer');
    clientId = map.get('oidc_client_id');
    clientSecret = map.get('oidc_client_secret');
    scope = map.get('oidc_scope');
  } catch {
    // 表不存在（迁移未跑）→ 落到环境变量兜底
  }
  issuer = issuer ?? c.env.OIDC_ISSUER;
  clientId = clientId ?? c.env.OIDC_CLIENT_ID;
  clientSecret = clientSecret ?? c.env.OIDC_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) {
    return null; // 未配置：登录不可用（setup 流程尚未跑）
  }
  return {
    issuer,
    clientId,
    clientSecret,
    scope: scope ?? c.env.OIDC_SCOPE ?? 'openid profile email',
    redirectUri: `${requestOrigin(c.req.url)}/api/auth/callback`,
  };
}

/** 发起登录：302 到身份源授权页（整页跳转，壳里是一个按钮，§6.5）。 */
app.get('/api/auth/login', async (c) => {
  const config = await getOidcConfig(c);
  if (!config) {
    return c.json({ error: 'OIDC not configured (run setup first)' }, 503);
  }
  const metadata = await discover(config.issuer);
  const flow = await buildAuthorizationRequest(config, metadata);
  setCookie(c, FLOW_COOKIE, JSON.stringify(flow), {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    maxAge: FLOW_TTL_SECONDS,
  });
  return c.redirect(flow.authorizeUrl);
});

/** 授权回调：state/PKCE/nonce 校验 → 换 token → JIT 建档 → 签会话 Cookie。 */
app.get('/api/auth/callback', async (c) => {
  const config = await getOidcConfig(c);
  if (!config) {
    return c.json({ error: 'OIDC not configured' }, 503);
  }
  const raw = getCookie(c, FLOW_COOKIE);
  if (!raw) {
    return c.json({ error: 'login flow expired, retry login' }, 400);
  }
  let flow: AuthorizationRequest;
  try {
    flow = JSON.parse(raw) as AuthorizationRequest;
  } catch {
    return c.json({ error: 'corrupted login flow cookie' }, 400);
  }
  const metadata = await discover(config.issuer);
  const result = await exchangeAuthorizationCode(config, metadata, c.req.url, {
    state: flow.state,
    nonce: flow.nonce,
    codeVerifier: flow.codeVerifier,
  });
  deleteCookie(c, FLOW_COOKIE, { path: '/' });

  // JIT 建档（requirements #20：OIDC 首登自动建档复用；issuer+sub 映射只存核心）
  const uid = await upsertUser(c.env.CORE_DB, {
    issuer: config.issuer,
    sub: String(result.claims.sub),
    name: pickDisplayName(result.claims),
  });

  // 回原目标（直访落工作台由 shell 处理；这里只接受站内路径）
  const next = sanitizeNext(new URL(c.req.url).searchParams.get('next'));

  const secret = c.env.JWT_PRIVATE_KEY;
  if (!secret) {
    return c.json({ error: 'signing key not provisioned (run deploy bootstrap)' }, 503);
  }
  const token = await createSessionToken(
    { uid, iss: config.issuer, sub: String(result.claims.sub), name: pickDisplayName(result.claims) },
    secret,
  );
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions());
  return c.redirect(next ?? '/');
});

/** 登出：清会话 Cookie（§5.2 壳广播登出消息给模块由 shell 完成）。 */
app.post('/api/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

/** 站内回跳白名单：仅允许本站绝对路径。 */
function sanitizeNext(next: string | null): string | null {
  if (!next) return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  return next;
}

/** 从 id_token claims 取展示名。 */
function pickDisplayName(claims: Record<string, unknown>): string {
  for (const key of ['name', 'preferred_username', 'email']) {
    const v = claims[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '用户';
}

/** JIT 建档：issuer+sub 唯一；存在则复用（更新展示名），否则插入。 */
async function upsertUser(
  db: D1Database,
  identity: { issuer: string; sub: string; name: string },
): Promise<string> {
  const existing = await db
    .prepare('SELECT id FROM users WHERE issuer = ? AND sub = ?')
    .bind(identity.issuer, identity.sub)
    .first<{ id: string }>();
  if (existing) {
    await db
      .prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .bind(identity.name, existing.id)
      .run();
    return existing.id;
  }
  const id = `u_${crypto.randomUUID().replace(/-/g, '')}`;
  await db
    .prepare('INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)')
    .bind(id, identity.issuer, identity.sub, identity.name, 'user')
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// setup / 模块 token（M0 后续 issue 实装）
// ---------------------------------------------------------------------------

// M0 骨架：租户激活流程尚未实现（#6）
app.post('/api/setup/activate', (c) =>
  c.json({ error: 'not implemented (M0 scaffold)' }, 501)
);

/**
 * 模块 token 签发（§5.2）：
 * 壳持有会话后为 iframe 模块取 token 的端点；aud=模块 id，10 分钟有效。
 * 门禁：会话必须有效；模块必须存在且 enabled（注册表开关）。
 */
app.post('/api/modules/:id/token', async (c) => {
  const secret = c.env.JWT_PRIVATE_KEY;
  if (!secret) {
    return c.json({ error: 'signing key not provisioned (run deploy bootstrap)' }, 503);
  }
  const session = await readSession(c);
  if (!session) {
    return c.json({ error: 'authentication required' }, 401);
  }
  const moduleId = c.req.param('id');
  const gate = await checkTokenGate(c.env.CORE_DB, moduleId);
  if (!gate.ok) {
    return c.json({ error: gate.error ?? 'forbidden' }, (gate.status ?? 403) as 401 | 403 | 404);
  }
  const runtime = await deriveSigningRuntimeOnce(secret);
  const issued = await issueModuleToken(
    runtime,
    { userId: session.uid, moduleId },
    { issuer: MODULE_TOKEN_ISSUER, caps: capsFromManifest(gate.manifest!.manifest_json) },
  );
  return c.json(issued);
});

/** 实例公钥集：模块后端与 SDK 验签的唯一真值来源（§5.2）。 */
app.get('/.well-known/jwks.json', async (c) => {
  const secret = c.env?.JWT_PRIVATE_KEY;
  if (!secret) {
    return c.json({ error: 'signing key not provisioned (run deploy bootstrap)' }, 503);
  }
  const runtime = await deriveSigningRuntimeOnce(secret);
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

// keep referenced imports honest（#6 将消费 verifySessionToken）
type _SessionPayload = SessionPayload;
void readSession;

export default app;
