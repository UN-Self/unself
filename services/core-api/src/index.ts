// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from 'hono';
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
import {
  listModules,
  ModuleRegistrationSchema,
  toggleModule,
  upsertModule,
} from './registry';
import { z } from 'zod';
import {
  audit,
  consumeSetupToken,
  generateSetupToken,
  isSetupDone,
  markSetupDone,
  promoteToAdmin,
  storeSetupToken,
} from './setup';

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

/**
 * 搭建向导 test-connection（#44）：服务端代理探测 issuer 发现文档。
 * 浏览器直连会被 IdP CORS 拦（Stalwart 实测命中），改经 core-api。
 * 匿名可调：只回结构化结果（成功含端点、失败统一不透传内部细节）。
 */
app.post('/api/oidc/test-connection', async (c) => {
  const parsed = z.object({ issuer: z.string() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ ok: false, error: 'body must be { issuer: string }' }, 400);
  }
  const { issuer } = parsed.data;
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    return c.json({ ok: false, error: 'issuer must be https' }, 400);
  }
  // 与 oidc.ts discover() 一致：https 门禁（NODE_ENV=test 允许 http）
  if (issuerUrl.protocol !== 'https:' && process.env.NODE_ENV !== 'test') {
    return c.json({ ok: false, error: 'issuer must be https' }, 400);
  }
  try {
    const metadata = await discover(issuer);
    return c.json({
      ok: true,
      issuer: metadata.issuer,
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
    });
  } catch {
    // 匿名调用方不透传内部错误（discover 错误可能含 fetch 详情/内网地址）
    return c.json({ ok: false, error: 'discovery failed' }, 502);
  }
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

// ---------------------------------------------------------------------------
// setup：一次性 token + 首个管理员（§5.2）
// 部署输出一次性链接：/setup?token=xxx（#10 前端页用）；后端负责校验与封死。
// ---------------------------------------------------------------------------

/** 部署脚本/自检：生成新一次性 setup token 并入库（打印进部署输出）。 */
app.post('/api/admin/setup-token', async (c) => {
  const db = c.env.CORE_DB;
  if (await isSetupDone(db)) {
    return c.json({ error: 'setup already completed; sealed forever' }, 409);
  }
  const { token } = generateSetupToken();
  await storeSetupToken(db, token);
  await audit(db, 'system', 'setup_token_issued');
  return c.json({ token, setupUrl: `/setup?token=${token}` });
});

/** setup 状态查询（#10 向导页用）：是否已激活 / token 是否仍可用。 */
app.get('/api/setup/status', async (c) => {
  const db = c.env.CORE_DB;
  const done = await isSetupDone(db);
  if (done) {
    return c.json({ done: true });
  }
  const token = c.req.query('token');
  if (!token) {
    return c.json({ done: false, tokenValid: false });
  }
  const row = await db
    .prepare('SELECT used_at FROM setup_tokens WHERE token = ?')
    .bind(token)
    .first<{ used_at: string | null }>();
  return c.json({ done: false, tokenValid: Boolean(row && !row.used_at) });
});

/** instance_config 键与激活 body 字段的映射（与 getOidcConfig 读取键一致）。 */
const OIDC_CONFIG_KEYS = {
  issuer: 'oidc_issuer',
  clientId: 'oidc_client_id',
  clientSecret: 'oidc_client_secret',
  scope: 'oidc_scope',
} as const;

/** 激活 body 中合法 OIDC 字段的形状（非法/缺失 → 忽略该字段）。 */
const OIDC_FIELD_SCHEMAS = {
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scope: z.string().min(1),
} as const;

/**
 * 把向导录入的 OIDC 字段写入 instance_config（UPSERT，与 markSetupDone 同语法）。
 * 返回是否有字段落库（全部无效返回 false，调用方据此决定是否审计）。
 */
async function persistOidcConfig(
  db: D1Database,
  body: Record<string, unknown> | null,
): Promise<boolean> {
  let stored = false;
  for (const field of Object.keys(OIDC_CONFIG_KEYS) as Array<keyof typeof OIDC_CONFIG_KEYS>) {
    const parsed = OIDC_FIELD_SCHEMAS[field].safeParse(body?.[field]);
    if (!parsed.success) continue;
    await db
      .prepare(
        'INSERT INTO instance_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime(\'now\')',
      )
      .bind(OIDC_CONFIG_KEYS[field], parsed.data)
      .run();
    stored = true;
  }
  return stored;
}

/**
 * 激活：校验一次性 token + 当前 OIDC 会话，登记首个管理员，永久封死 setup。
 * 可选 JSON body 携带向导录入的 OIDC 字段（camelCase，见 OIDC_CONFIG_KEYS）；
 * 字段非法/缺失则忽略——保持纯 token 激活向后兼容。
 * 已激活后一律拒绝（§6.5：已激活后访问 /setup 一律重定向，页面不复存在）。
 */
app.post('/api/setup/activate', async (c) => {
  const db = c.env.CORE_DB;
  if (await isSetupDone(db)) {
    return c.json({ error: 'setup already completed; sealed forever' }, 409);
  }
  const token = c.req.query('token') ?? c.req.header('x-setup-token');
  if (!token) {
    return c.json({ error: 'missing setup token' }, 400);
  }
  const session = await readSession(c);
  if (!session) {
    // 未登录：提示需先登录（#10 前端带 token 跳 /api/auth/login?next=...）
    const loginUrl = new URL('/api/auth/login', c.req.url);
    loginUrl.searchParams.set('next', `/setup?token=${encodeURIComponent(token)}`);
    return c.json({ error: 'authentication required', loginUrl: loginUrl.toString() }, 401);
  }
  const consumed = await consumeSetupToken(db, token);
  if (!consumed) {
    return c.json({ error: 'invalid or already-used setup token' }, 403);
  }
  // 向导录入的 OIDC 字段落库（consume 成功后、promoteToAdmin 前；字段非法/缺失忽略）
  const oidcBody = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (await persistOidcConfig(c.env.CORE_DB, oidcBody)) {
    await audit(db, session.uid, 'oidc_config_stored');
  }
  await promoteToAdmin(db, session.uid);
  await markSetupDone(db);
  await audit(db, session.uid, 'setup_activated', session.uid);
  return c.json({ ok: true, user: { id: session.uid, name: session.name, role: 'admin' } });
});

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
  const runtime = await getSigningRuntime(secret);
  if (!runtime) {
    return c.json({ error: 'signing key not provisioned (run deploy bootstrap)' }, 503);
  }
  const issued = await issueModuleToken(
    runtime,
    { userId: session.uid, moduleId },
    { issuer: MODULE_TOKEN_ISSUER, caps: capsFromManifest(gate.manifest!.manifest_json) },
  );
  return c.json(issued);
});

// ---------------------------------------------------------------------------
// 模块注册表（#7）：deploy 脚本注册/upsert（装配时一次），运行时启停翻转（秒级）
// 管理端点持有管理员会话；成员读接口只回 enabled（§5.5 装配/启停分离）
// ---------------------------------------------------------------------------

/**
 * 管理员守卫：注册表写操作与全量列表仅限 admin 角色（§2 角色）。
 * 返回 null 表示已放行；否则直接返回 401/403 响应。
 */
async function requireAdmin(
  c: Context<{ Bindings: Bindings }>,
): Promise<Response | null> {
  const session = await readSession(c);
  if (!session) {
    return c.json({ error: 'authentication required' }, 401);
  }
  const roleRow = await c.env.CORE_DB.prepare('SELECT role FROM users WHERE id = ?')
    .bind(session.uid)
    .first<{ role: string }>();
  if (roleRow?.role !== 'admin') {
    return c.json({ error: 'admin required' }, 403);
  }
  return null;
}

/** 注册/更新模块（deploy 脚本装配时调用；manifest 快照随注册刷新）。 */
app.post('/api/admin/modules', async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const parsed = ModuleRegistrationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid registration', detail: z.prettifyError(parsed.error) }, 400);
  }
  const entry = await upsertModule(c.env.CORE_DB, parsed.data);
  await audit(c.env.CORE_DB, (await readSession(c))!.uid, 'module_upserted', parsed.data.id);
  return c.json(entry, 201);
});

/** 翻转启停：运行时秒级生效（边栏隐藏 + token 门禁拒发，§5.5）。 */
app.patch('/api/admin/modules/:id/enabled', async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean') {
    return c.json({ error: 'body must be { enabled: boolean }' }, 400);
  }
  const result = await toggleModule(c.env.CORE_DB, c.req.param('id'), body.enabled);
  if (!result) {
    return c.json({ error: 'module not found' }, 404);
  }
  await audit(
    c.env.CORE_DB,
    (await readSession(c))!.uid,
    body.enabled ? 'module_enabled' : 'module_disabled',
    c.req.param('id'),
  );
  return c.json(result);
});

/** 全量列表（管理端，含停用）。 */
app.get('/api/admin/modules', async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  return c.json(await listModules(c.env.CORE_DB));
});

/** 成员侧：仅启用模块（边栏/nav 数据源，#12 消费）。 */
app.get('/api/modules', async (c) => {
  const all = await listModules(c.env.CORE_DB);
  return c.json(all.filter((m) => m.enabled));
});

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
