// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from 'hono';
import type { ModuleTokenClaims } from '@unself/contracts';
import { createCoreApiStorage, verifyModuleToken, type ModuleStorage } from '@unself/sdk';

/**
 * hello 模块（#13，M0 垂直切片验收载体）：
 * - requireAuth 验签收口：SDK 本地 JWKS 验签（部署期注入 CORE_JWKS_JSON，§5.2 B 方案零运行时网络）+ aud=hello，/api/* 与 /life/* 共用（#45 遗留项①，认证去重）
 * - GET /api/count：经 SDK 存储接口读写计数（#9 前缀守卫）
 * - GET /life/export、POST /life/purge：模块生命周期骨架（§5.4 契约，requireAuth 同 count 规）
 * - 页面：身份行（claims 姓名/邮箱）+ 计数 + [+1] 并排（≤50 行样式，tokens 化）
 *
 * 数据落点 = `core`（#248 收敛（a)）：模块不直连任何数据库，计数经 **Core API 代理**
 * （`/api/module-api/storage/*` 四形状）读写。跨 worker 走 **Service Binding CORE_API**
 * （同 zone 明文 fetch 被 CF 平台禁，见装配引擎 assemble 注释 #71 根因）；模块把自己的
 * 模块 token 原样转交 core-api，权限裁决只发生在服务端注册表快照（前端只是视图）。
 */

export interface Bindings {
  /** core-api worker 的 Service Binding。CF 态才有；npm / docker 走 UNSELF_CORE_URL。 */
  CORE_API?: Fetcher;
  /** Core 公钥 JWKS 的 JSON 序列化（部署期注入，§5.2 B 方案：模块本地验签，零运行时网络）。 */
  CORE_JWKS_JSON?: string;
  /** Core issuer（可选校验；M0 以 aud 锁定为主）。 */
  CORE_ISSUER?: string;
}

/** 模块 id：aud 锁定 + SDK 存储子域 + 表前缀三处一致。 */
const MODULE_ID = 'hello';

/** Service Binding 调用用的占位 origin（host 不参与路由；core-api 按路径匹配，决策 #63）。 */
const CORE_API_ORIGIN = 'https://core-api.internal';

/**
 * 构造 core 级存储客户端（#248 收敛（a)）：token 取当前请求的模块 token（原样转交 core-api 验签），
 * 传输走 Service Binding（不经公网、不受同 zone fetch 禁令影响）。
 */
function coreUrlFromEnv(): string {
  return (process.env.UNSELF_CORE_URL ?? '').replace(/\/+$/, '');
}

/** CF 走 Service Binding；npm / docker 用同一套 /api/module-api/storage，只是 fetch 到 UNSELF_CORE_URL。 */
function storeFor(c: Context<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>): ModuleStorage {
  const bearer = (c.req.header('authorization') ?? '').slice(7);
  if (c.env.CORE_API) {
    return createCoreApiStorage({
      coreApiOrigin: CORE_API_ORIGIN,
      getToken: () => bearer,
      fetchImpl: (url, init) => c.env.CORE_API!.fetch(url, init),
    });
  }
  const coreUrl = coreUrlFromEnv();
  return createCoreApiStorage({
    coreApiOrigin: coreUrl,
    getToken: () => bearer,
    fetchImpl: (url, init) => {
      const target = new URL(url);
      return fetch(`${coreUrl}${target.pathname}${target.search}`, init);
    },
  });
}

function storageReady(c: Context<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>): boolean {
  return Boolean(c.env.CORE_API) || coreUrlFromEnv() !== '';
}

/** 计数键：SDK 键为模块子域裸键（core-api 侧落 module_kv(module_id='hello', key='counter')）。 */
const COUNTER_KEY = 'counter';

async function readCount(store: ModuleStorage): Promise<number> {
  const raw = await store.get(COUNTER_KEY);
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function writeCount(store: ModuleStorage, value: number): Promise<void> {
  await store.put(COUNTER_KEY, String(value));
}

const app = new Hono<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>();

/** 模块页：身份行（claims 姓名/邮箱）+ 计数 + [+1] 并排；样式只取 tokens。
 *  页面内 fetch/import 全部用相对路径（不帶前导 /）：同一路径制下模块同时挂载在
 *  /m/<id>/（部署）与开发期根路径，根相对路径只在后者成立——相对路径两处皆可（#14）。 */
app.get('/', (c) => {
  return c.html(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>hello</title>
  <style>
    /* 令牌唯一来源 = 壳注入 style#unself-tokens（§6.5.5 通道 A：同源 iframe 直注）
     * 与 SDK 通道 B（ready 握手 postMessage 下发 tokens）——页面只引用 --unself- 前缀
     * 的 CSS 变量，不持有任何值副本（§6.5.5 禁内联值；更换主题不重部署即可全站生效）。 */
    * { box-sizing: border-box; }
    body { margin:0; font:var(--unself-font-size-base)/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;
           color:var(--unself-color-text); background:var(--unself-color-bg); }
    main { display:flex; min-height:100vh; align-items:center; justify-content:center; padding:var(--unself-space-4); }
    .card { display:flex; align-items:center; gap:var(--unself-space-6); flex-wrap:wrap; justify-content:center;
            padding:var(--unself-space-6) var(--unself-space-8); border:1px solid var(--unself-color-border); border-radius:var(--unself-radius-lg); }
    .identity { display:flex; flex-direction:column; gap:var(--unself-space-1); }
    .identity .name { font-size:var(--unself-font-size-lg); font-weight:600; }
    .identity .email { font-size:var(--unself-font-size-sm); color:var(--unself-color-text-secondary); }
    button { height:48px; padding:0 var(--unself-space-6); border:none; border-radius:var(--unself-radius-md);
             background:var(--unself-color-primary); color:var(--unself-color-bg); font-size:var(--unself-font-size-base); font-weight:500; cursor:pointer; }
    button:disabled { opacity:.6; cursor:wait; }
    .count { font-size:var(--unself-font-size-xl); font-variant-numeric:tabular-nums; min-width:var(--unself-space-8); text-align:center; }
    .err { width:100%; text-align:center; color:var(--unself-color-danger); font-size:var(--unself-font-size-sm); }
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
    import { createModuleSDK, resolveShellOrigin } from './sdk/module-sdk.esm.js';

    // coreOrigin = 壳 origin，不是本页 origin：workers.dev 形态下模块挂自有子域（跨子域 iframe），
    // location.origin 是模块自己 → 入站 token 校验永远不中。resolveShellOrigin() 优先级 =
    // ancestorOrigins[0]（浏览器给的祖先 origin）→ wrapper 注入 meta → location.origin（非 iframe 直开回落）。
    const sdk = createModuleSDK({ moduleId: 'hello', coreOrigin: resolveShellOrigin() });
    const who = document.getElementById('who');
    const email = document.getElementById('email');
    const count = document.getElementById('count');
    const plus = document.getElementById('plus');
    const err = document.getElementById('err');

    function fail(message) { err.textContent = message; err.hidden = false; }

    async function refresh() {
      const res = await fetch('api/count', { headers: { authorization: 'Bearer ' + (window.__helloToken ?? '') } });
      if (res.status === 401) { fail('登录已过期，请刷新页面'); return; }
      if (!res.ok) return;
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

/** greeting 缺省链尾：无声明/无值/default 时的人话兜底。 */
const GREETING_FALLBACK = 'Hello';

/** config 响应里的 greeting 取值链：values.greeting → 声明 default → 兜底。 */
function greetingFromConfig(state: { config?: Array<{ key: string; default?: unknown }>;
  values?: Record<string, unknown> }): string {
  const value = state.values?.greeting;
  if (typeof value === 'string' && value !== '') return value;
  const fallback = state.config?.find((f) => f.key === 'greeting')?.default;
  if (typeof fallback === 'string' && fallback !== '') return fallback;
  return GREETING_FALLBACK;
}

/** key 明文的唯一去处：算成哈希 → 过网（host.ts 同款，明文不出本函数）。 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 读配置态（#349 U8 ⑤）：两种运行体两条轨道，同一响应形状 { config, values }。
 * - worker 态：Service Binding CORE_API 代理（Bearer 原样转交，同 storeFor 通道）；
 * - node 态（反连宿主，无 binding）：keyHash 即凭证（同 WS 握手），内联 fetch 到
 *   UNSELF_CORE_URL 的 /api/module-api/config?keyHash=——SDK fetchConfig 是浏览器/宿主
 *   两用形状，node 态此处直连（少一层封装，行为与 fetchConfig(keyHash) 等价）。
 */
async function fetchConfigState(
  c: Context<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>,
): Promise<{ config: Array<{ key: string; default?: unknown }>; values: Record<string, unknown> } | null> {
  if (c.env.CORE_API) {
    const bearer = (c.req.header('authorization') ?? '').slice(7);
    const res = await c.env.CORE_API.fetch('https://core-api.internal/api/module-api/config', {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as { config: Array<{ key: string; default?: unknown }>; values: Record<string, unknown> };
  }
  const coreUrl = (process.env.UNSELF_CORE_URL ?? '').replace(/\/+$/, '');
  const moduleKey = process.env.UNSELF_MODULE_KEY ?? '';
  if (!coreUrl || !moduleKey) return null;
  const keyHash = await sha256Hex(moduleKey);
  const res = await fetch(`${coreUrl}/api/module-api/config?keyHash=${keyHash}`);
  if (!res.ok) return null;
  return (await res.json()) as { config: Array<{ key: string; default?: unknown }>; values: Record<string, unknown> };
}

/**
 * 问候语（#349 U8 ③ hello 闭环演示）：设 greeting → 模块页/接口返回新值。
 * worker 态在模块 token 门禁内（同 /api/count 规）；node 态（keyHash 轨）无 token 通道，
 * 凭证即 keyHash——与反连握手同一安全模型。取值链见 greetingFromConfig。
 */
app.get('/api/greeting', async (c) => {
  if (!c.env.CORE_API && !(process.env.UNSELF_CORE_URL && process.env.UNSELF_MODULE_KEY)) {
    return c.json({ error: 'config not available: missing CORE_API binding or UNSELF_CORE_URL / UNSELF_MODULE_KEY' }, 503);
  }
  if (c.env.CORE_API) {
    const authError = await requireAuth(c);
    if (authError) return authError;
  }
  const state = await fetchConfigState(c);
  if (!state) {
    return c.json({ error: 'config unreachable' }, 502);
  }
  return c.json({ greeting: greetingFromConfig(state) });
});

// SDK 静态文件（页面 import /sdk/module-sdk.esm.js）：不再在这里兜 501——host 态由
// @unself/sdk/host 自供（先于业务，serveSdkAssetsFrom），部署态由装配资产拦截；
// 资产缺失（sdk 未构建）时 host 返回不认领，业务侧自然 404，不再伪装「未实现」。

/** 计数读取（验签后）。 */
/** CF 本地验签；npm / docker 没有 JWKS，把模块 token 原样交给 core（与 worker 同一存储接口）。 */
async function openCount(
  c: Context<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>,
): Promise<Response | null> {
  if (!storageReady(c)) {
    return c.json({ error: 'storage binding missing' }, 503);
  }
  if (c.env.CORE_API) {
    return requireAuth(c);
  }
  if (!c.req.header('authorization')?.startsWith('Bearer ')) {
    return c.json({ error: 'missing bearer token', requestId: c.req.header('x-request-id') }, 401);
  }
  return null;
}

app.get('/api/count', async (c) => {
  const blocked = await openCount(c);
  if (blocked) return blocked;
  return c.json({ count: await readCount(storeFor(c)) });
});

/** 计数 +1（验签后；读改写原子性在 M0 单实例串行下可接受）。 */
app.post('/api/count', async (c) => {
  const blocked = await openCount(c);
  if (blocked) return blocked;
  const store = storeFor(c);
  const next = (await readCount(store)) + 1;
  await writeCount(store, next);
  return c.json({ count: next });
});

/** 用请求内 Bearer 做一次性验签（全模块认证唯一收口：本地 JWKS，零运行时网络）。 */
async function requireAuth(
  c: Context<{ Bindings: Bindings; Variables: { claims: ModuleTokenClaims } }>,
): Promise<Response | null> {
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'missing bearer token', requestId: c.req.header('x-request-id') }, 401);
  }
  const coreJwksJson = c.env.CORE_JWKS_JSON;
  if (!coreJwksJson) {
    return c.json({ error: 'jwks not provisioned', requestId: c.req.header('x-request-id') }, 503);
  }
  try {
    const claims = await verifyModuleToken(auth.slice(7), {
      coreJwksJson,
      audience: MODULE_ID,
    });
    c.set('claims', claims);
    return null;
  } catch {
    return c.json({ error: 'token invalid or expired', requestId: c.req.header('x-request-id') }, 401);
  }
}

/** 生命周期骨架（§5.4 契约；M0 返回契约形状，全量实现随 M1 卸载剧本）。
 * 认证与 /api/count 同规（#45 遗留项②）：storage 缺绑定 503，验签不过 401。 */
app.get('/life/export', async (c) => {
  if (!c.env.CORE_API) {
    return c.json({ error: 'storage binding missing' }, 503);
  }
  const authError = await requireAuth(c);
  if (authError) return authError;
  // core 级落点（#248）：模块没有自己的表，导出 = 本模块在 Core API 代理侧的键值行
  // （表名 module_kv 是平台基建表，行已由 core-api 按 aud 收口到本模块子域）。
  const store = storeFor(c);
  const rows: Array<{ key: string; value: string }> = [];
  for (const key of await store.list()) {
    rows.push({ key, value: (await store.get(key)) ?? '' });
  }
  return c.json({
    version: 1,
    moduleId: MODULE_ID,
    exportedAt: new Date().toISOString(),
    tables: {
      module_kv: { schemaVersion: 1, rows },
    },
    files: [],
  });
});

app.post('/life/purge', async (c) => {
  if (!c.env.CORE_API) {
    return c.json({ error: 'storage binding missing' }, 503);
  }
  const authError = await requireAuth(c);
  if (authError) return authError;
  const store = storeFor(c);
  for (const key of await store.list()) {
    await store.delete(key);
  }
  return c.json({ ok: true });
});

export default app;
