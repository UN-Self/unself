// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { ModuleTokenClaims } from '@unself/contracts';
import { createD1Storage, type D1MinimalDatabase } from '@unself/module-sdk';

/**
 * hello 模块（#13，M0 垂直切片验收载体）：
 * - verifyModuleToken 中间件：jose + Core JWKS 验签 + aud=hello（§5.2）
 * - GET /api/count：经 SDK 存储接口读写 hello_counter（#9 前缀守卫）
 * - GET /life/export、POST /life/purge：模块生命周期骨架（§5.4 契约）
 * - 页面：身份行（claims 姓名/邮箱）+ 计数 + [+1] 并排（≤50 行样式，tokens 化）
 */

export interface Bindings {
  MODULES_DB: D1Database;
  /** Core 实例 JWKS 端点（验签公钥真值来源，§5.2）。 */
  CORE_JWKS_URL?: string;
  /** Core issuer（可选校验；M0 以 aud 锁定为主）。 */
  CORE_ISSUER?: string;
}

/** 模块 id：aud 锁定 + SDK 存储子域 + 表前缀三处一致。 */
const MODULE_ID = 'hello';

/** Bearer 提取 + JWKS 验签 + claims 校验（aud=hello）；失败回 401 人话。 */
export function createAuthMiddleware(jwksUrl: string): MiddlewareHandler<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }> {
  const JWKS = createRemoteJWKSet(new URL(jwksUrl));
  return async (c, next) => {
    const auth = c.req.header('authorization');
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'missing bearer token', requestId: c.req.header('x-request-id') }, 401);
    }
    try {
      const { payload } = await jwtVerify(auth.slice(7), JWKS, { audience: MODULE_ID });
      // claims 形状契约校验（ModuleTokenClaimsSchema），SDK 侧 decodeContext 同规
      const { ModuleTokenClaimsSchema } = await import('@unself/contracts');
      c.set('claims', ModuleTokenClaimsSchema.parse(payload));
      await next();
    } catch {
      // §6.5 人话 + request id：不回 jose 原始错误
      return c.json({ error: 'token invalid or expired', requestId: c.req.header('x-request-id') }, 401);
    }
  };
}

/** SDK 存储接口（#9）：MODULES_DB + moduleId 子域收口，跨前缀由 SDK 拒绝。 */
function storage(db: D1Database): D1MinimalDatabase {
  // D1 绑定满足 SDK 最小结构类型（prepare/bind/first/all/run）
  return db as unknown as D1MinimalDatabase;
}

/** 计数键：SDK 键为模块子域裸键，落 module_kv(module_id='hello', key='counter')。 */
const COUNTER_KEY = 'counter';

async function readCount(db: D1Database): Promise<number> {
  const store = createD1Storage({ db: storage(db), moduleId: MODULE_ID });
  const raw = await store.get(COUNTER_KEY);
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function writeCount(db: D1Database, value: number): Promise<void> {
  const store = createD1Storage({ db: storage(db), moduleId: MODULE_ID });
  await store.put(COUNTER_KEY, String(value));
}

const app = new Hono<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>();

/** 模块页：身份行（claims 姓名/邮箱）+ 计数 + [+1] 并排；样式只取 tokens。
 *  页面内 fetch/import 全部用相对路径（不帶前导 /）：同一路径制下模块同时挂载在
 *  /m/<id>/（部署）与开发期根路径，根相对路径只在后者成立——相对路径两处皆可（#14）。 */
app.get('/', (c) => {
  const jwksUrl = c.env?.CORE_JWKS_URL ?? '/.well-known/jwks.json';
  return c.html(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>hello</title>
  <style>
    :root { --bg:#ffffff; --border:#e4e4e1; --text:#1c1917; --secondary:#78716c; --primary:#2563eb; --primary-soft:#dbeafe; --radius:8px; }
    * { box-sizing: border-box; }
    body { margin:0; font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif; color:var(--text); background:var(--bg); }
    main { display:flex; min-height:100vh; align-items:center; justify-content:center; padding:16px; }
    .card { display:flex; align-items:center; gap:24px; flex-wrap:wrap; justify-content:center;
            padding:24px 32px; border:1px solid var(--border); border-radius:12px; }
    .identity { display:flex; flex-direction:column; gap:4px; }
    .identity .name { font-size:16px; font-weight:600; }
    .identity .email { font-size:13px; color:var(--secondary); }
    button { height:48px; padding:0 24px; border:none; border-radius:var(--radius);
             background:var(--primary); color:#fff; font-size:14px; font-weight:500; cursor:pointer; }
    button:disabled { opacity:.6; cursor:wait; }
    .count { font-size:20px; font-variant-numeric:tabular-nums; min-width:32px; text-align:center; }
    .err { width:100%; text-align:center; color:#dc2626; font-size:13px; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <div class="identity">
        <span class="name" id="who">加载中…</span>
        <span class="email" id="email"></span>
      </div>
      <span class="count" id="count">–</span>
      <button id="plus" type="button">+1</button>
      <p class="err" id="err" role="alert" hidden></p>
    </div>
  </main>
  <script type="module">
    // 装配产物中 sdk/module-sdk.js 是 esbuild IIFE 无顶层 export，浏览器 ESM 具名导入会报 SyntaxError；
    // module-sdk.esm.js 是同包二次打包的 ESM 产物（assemble.ts 已生成），具名导出可用。
    import { createModuleSDK } from './sdk/module-sdk.esm.js';

    const sdk = createModuleSDK({ moduleId: 'hello', coreOrigin: window.location.origin });
    const who = document.getElementById('who');
    const email = document.getElementById('email');
    const count = document.getElementById('count');
    const plus = document.getElementById('plus');
    const err = document.getElementById('err');

    function fail(message) { err.textContent = message; err.hidden = false; }

    async function refresh() {
      const res = await fetch('api/count', { headers: { authorization: 'Bearer ' + (window.__helloToken ?? '') } });
      if (!res.ok) { fail(res.status === 401 ? '登录已过期，请刷新页面' : '计数加载失败'); return; }
      count.textContent = String((await res.json()).count ?? 0);
    }

    // 握手：ready → 壳下发 token（静默续期循环由 SDK 处理）
    sdk.ready();
    const token = await sdk.waitForToken();
    window.__helloToken = token;
    // claims 展示（身份行：证明系统认识你，§6.5 hello 页动线）
    const claims = sdk.decodeContext(window.__helloToken);
    who.textContent = claims.name ?? claims.sub;
    email.textContent = claims.email ?? '';
    await refresh();

    plus.addEventListener('click', async () => {
      plus.disabled = true;
      try {
        const res = await fetch('api/count', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + (window.__helloToken ?? '') },
        });
        if (res.status === 401) { fail('登录已过期，请刷新页面'); return; }
        if (!res.ok) { fail('计数失败，请稍后重试'); return; }
        count.textContent = String((await res.json()).count ?? 0);
        err.hidden = true;
      } catch { fail('网络不可用，请重试'); }
      finally { plus.disabled = false; }
    });

    // 静默续期：token 更新后跟随刷新本地副本
    sdk.startTokenLoop(window.__helloToken, (next) => { window.__helloToken = next; });
  </script>
</body>
</html>`);
});

app.get('/api/health', (c) => c.json({ ok: true, service: 'module-hello' }));

// SDK 静态文件（页面 import /sdk/module-sdk.js）：开发期直映 node_modules 源；
// 部署期由 wrangler 构建打包（#14 装配脚本职责）。
app.get('/sdk/*', (c) => c.json({ error: 'sdk asset served by deploy bundler (M0 dev: vite alias)' }, 501));

/** 计数读取（验签后）。 */
app.get('/api/count', async (c) => {
  if (!c.env.MODULES_DB) {
    return c.json({ error: 'storage binding missing' }, 503);
  }
  const authError = await requireAuth(c);
  if (authError) return authError;
  return c.json({ count: await readCount(c.env.MODULES_DB) });
});

/** 计数 +1（验签后；读改写原子性在 M0 单实例串行下可接受）。 */
app.post('/api/count', async (c) => {
  if (!c.env.MODULES_DB) {
    return c.json({ error: 'storage binding missing' }, 503);
  }
  const authError = await requireAuth(c);
  if (authError) return authError;
  const next = (await readCount(c.env.MODULES_DB)) + 1;
  await writeCount(c.env.MODULES_DB, next);
  return c.json({ count: next });
});

/** 用请求内 Bearer 做一次性验签（测试可注入 fake JWKS；运行时与中间件同规）。 */
async function requireAuth(
  c: Context<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>,
): Promise<Response | null> {
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'missing bearer token', requestId: c.req.header('x-request-id') }, 401);
  }
  const jwksUrl = c.env.CORE_JWKS_URL;
  if (!jwksUrl) {
    return c.json({ error: 'jwks not configured', requestId: c.req.header('x-request-id') }, 503);
  }
  try {
    const { payload } = await jwtVerify(auth.slice(7), createRemoteJWKSet(new URL(jwksUrl)), {
      audience: MODULE_ID,
    });
    const { ModuleTokenClaimsSchema } = await import('@unself/contracts');
    c.set('claims', ModuleTokenClaimsSchema.parse(payload));
    return null;
  } catch {
    return c.json({ error: 'token invalid or expired', requestId: c.req.header('x-request-id') }, 401);
  }
}

/** 生命周期骨架（§5.4 契约；M0 返回契约形状，全量实现随 M1 卸载剧本）。 */
app.get('/life/export', async (c) => {
  const db = c.env.MODULES_DB;
  const count = db ? await readCount(db) : 0;
  return c.json({
    version: 1,
    moduleId: MODULE_ID,
    exportedAt: new Date().toISOString(),
    tables: {
      hello_counter: { schemaVersion: 1, rows: count > 0 ? [{ scope: 'global', n: count }] : [] },
    },
    files: [],
  });
});

app.post('/life/purge', async (c) => {
  if (!c.env.MODULES_DB) {
    return c.json({ error: 'storage binding missing' }, 503);
  }
  const store = createD1Storage({ db: storage(c.env.MODULES_DB), moduleId: MODULE_ID });
  for (const key of await store.list()) {
    await store.delete(key);
  }
  return c.json({ ok: true });
});

export default app;
