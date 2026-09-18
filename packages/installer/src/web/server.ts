// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 本地 Web 向导 HTTP 壳（#53/#70）：node:http 零新依赖。
 * - GET /            页面（页头常驻「实例目录：<path>」+ 复制按钮 + 六段流表单）
 * - POST /api/step1…4  单步状态机推进（JSON；校验失败 400 + 人话 problem）
 * - GET /api/state    状态投影（永不携带 token 明文；带幂等重跑标语 ⑥）
 * - GET /api/events   事件流（SSE：进度日志推给页面 ④）
 * 部署执行器由 deps.deploy 注入（测试替身 / CLI 接九步引擎），向导壳不 import 引擎。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DEFAULT_THEME, tokenCssName } from '@unself/contracts';
import {
  apexZone,
  beginDeploy,
  chooseDomain,
  completeDeploy,
  confirmModules,
  failDeploy,
  needsTotalTls,
  pushEvent,
  resetWizard,
  submitToken,
  type WizardEnvHint,
  type WizardState,
} from './state';

/** envHint 缺省（向后兼容 #258）：只给 hasEnvToken 时其余字段的安全默认值。 */
const DEFAULT_ENV_HINT: WizardEnvHint = { hasEnvToken: false, oauthUsable: true, needsTotalTls: false, ci: false };

/** 合成宿主环境提示：deps.envHint（#246 新）逐字段覆盖默认；旧调用方只传 hasEnvToken → 映射进同名字段。 */
function resolveEnvHint(deps: WizardDeps): WizardEnvHint {
  if (deps.envHint) return { ...DEFAULT_ENV_HINT, ...deps.envHint };
  return { ...DEFAULT_ENV_HINT, hasEnvToken: deps.hasEnvToken };
}

export interface WizardDeps {
  /** 读当前状态（测试注入共享持有器）。 */
  getState: () => WizardState;
  /** 写回状态机推进结果。 */
  setState: (next: WizardState) => void;
  /**
   * 部署执行器：接收装配输入与事件回调；返回 baseUrl + setupToken。
   * 向导语义约定：失败即抛错（由壳转三要素）；事件文案原样广播。
   */
  deploy: (input: {
    domain: string;
    modules: string[];
    storage: { provider: 'r2'; bucket: string };
    onEvent: (text: string) => void;
  }) => Promise<{ baseUrl: string; setupToken: string | null }>;
  /** 环境已带凭证（CLOUDFLARE_API_TOKEN）：① 步页面展示「已检测」态。 */
  hasEnvToken: boolean;
  /**
   * 宿主环境提示（#246）：OAuth 可用性 / CI 态 / 多级子域——server 启动时由调用方
   * （oauthCallbackReachable + wrangler 探测）注入，壳内不读环境、不 import 引擎。
   * 缺省 = 全默认（oauthUsable=true、非 CI、非多级子域）。
   */
  envHint?: Partial<WizardEnvHint>;
}

export interface ServeOptions {
  port?: number;
  host?: string;
  deps: WizardDeps;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 失败三要素（与 deploy/cloudflare errors.advise 同款映射，已知的才归类，其余归 code 给幂等重跑）。 */
function advise(err: unknown): { cause: string; owner: 'token' | 'dns' | 'network' | 'code'; fix: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (/10405/.test(msg)) return { cause: msg.slice(0, 300), owner: 'token', fix: 'token 缺 Zone 级权限：按向导①的深链接重建 token 后重跑' };
  if (/ENOTFOUND|无法获取/.test(msg)) return { cause: msg.slice(0, 300), owner: 'dns', fix: 'DNS 未生效：等 60 秒重跑（幂等，只补没完成的部分）' };
  if (/fetch failed|ECONNRESET|ETIMEDOUT/.test(msg)) return { cause: msg.slice(0, 300), owner: 'network', fix: '网络中断或临时故障：检查网络后重跑' };
  return { cause: msg.slice(0, 300), owner: 'code', fix: '直接重跑即可：装配器幂等收敛，不会重复创建资源' };
}

/**
 * 向导页的令牌变量块：取值来自契约默认主题（`packages/contracts/src/theme-tokens.json`
 * 是令牌取值的唯一定义处），页面样式一律引用 `var(--unself-*)`——照 AGENTS「样式只走 tokens」。
 * 源码里不出现任何颜色字面量（取值在运行时由数据渲染出来），故 verify-tokens 规则一通过。
 */
function themeVarBlock(): string {
  return Object.entries(DEFAULT_THEME)
    .map(([dotted, value]) => `${tokenCssName(dotted)}: ${value};`)
    .join(' ');
}

/** ① 步引导语（#246）：oauthUsable=false 或 CI 态 → 人话引导创建 API Token；否则引导点开折叠入口。 */
function authGuidance(hint: WizardEnvHint): string {
  if (hint.ci) return '<p>没有可借用的 wrangler OAuth：创建 API Token 填进下面密码框（已设 CLOUDFLARE_API_TOKEN 则本步可跳过）。</p>';
  if (!hint.oauthUsable) return '<p>没有可借用的 wrangler OAuth：创建 API Token 填进下面密码框。</p>';
  return '<p>或点开下方 API Token 入口创建 Token，粘贴到下面密码框。</p>';
}

/**
 * ① 步折叠入口（决策 #66）：API Token 深链接默认收起，露出条件（任一）——
 * 需 Total TLS（多级子域）/ CI 态（无浏览器）/ oauthUsable=false。`<details>` 天然支持用户点开，无需 JS。
 */
function authDetails(hint: WizardEnvHint): string {
  const open = !hint.oauthUsable || hint.ci || hint.needsTotalTls ? ' open' : '';
  const title = hint.needsTotalTls
    ? '多级子域需要 Total TLS：OAuth 不覆盖，需 API Token'
    : '手动创建 API Token（深链接入口，权限已预选）';
  return `<details class="auth-fold"${open}>
  <summary>${title}</summary>
  <p><a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer noopener">打开 Cloudflare 创建 API Token</a></p>
  <p>权限清单与向导失败提示一致（Account：Workers Scripts/D1/R2 Edit；Zone：Workers Routes/DNS/SSL Edit），创建后整段复制粘贴到下面密码框（掩码输入，不落盘）。</p>
</details>`;
}

/** 页面：页头常驻实例目录（可复制）+ 六段流表单。 */
export function renderPage(state: WizardState, envHint: WizardEnvHint): string {
  const hint = envHint;
  const authNote = hint.hasEnvToken
    ? '<p>已检测到环境变量 CLOUDFLARE_API_TOKEN，本步可跳过。</p>'
    : authGuidance(hint);
  const oauthNote =
    hint.oauthUsable && !hint.ci
      ? '<p class="ok">检测到本机 wrangler OAuth，可零输入直跑（跳过本步）。</p>'
      : '';
  const banner = hint.ci
    ? '<p class="banner">CI/无浏览器环境：请用 CLOUDFLARE_API_TOKEN 或展开 API Token 入口</p>'
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unself 安装向导</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; ${themeVarBlock()} }
  body { max-width: 42rem; margin: 0 auto; padding: 1.5rem 1rem; color: var(--unself-color-text); background: var(--unself-color-bg); }
  header { border: 1px solid var(--unself-color-border); border-radius: 8px; padding: .75rem 1rem; margin-bottom: 1.5rem; }
  code { user-select: all; word-break: break-all; }
  section { margin: 1rem 0; padding: 1rem; border: 1px solid var(--unself-color-border); border-radius: 8px; }
  label { display: block; margin: .5rem 0; }
  input[type=password], input[type=text] { width: 100%; box-sizing: border-box; padding: .5rem; margin-top: .25rem; }
  .err { color: var(--unself-color-danger); white-space: pre-wrap; }
  ol li { margin: .25rem 0; }
  .banner { border: 1px solid var(--unself-color-warning); border-radius: var(--unself-radius-md); padding: var(--unself-space-2) var(--unself-space-3); background: var(--unself-color-surface); margin-bottom: var(--unself-space-3); }
  .ok { color: var(--unself-color-success); }
  details.auth-fold { border: 1px solid var(--unself-color-border); border-radius: var(--unself-radius-md); padding: var(--unself-space-2) var(--unself-space-3); margin: var(--unself-space-2) 0; }
  details.auth-fold summary { cursor: pointer; color: var(--unself-color-info); }
</style>
</head>
<body>
<header>
  <strong>实例目录</strong>：<code id="instance-path">${state.instancePath}</code>
  <button class="copy" type="button" data-copy="instance-path">复制</button>
</header>
<main data-step="${state.step}">
${banner}
<p>当前步骤：${state.step}。任何时候重跑都收敛同一终态（幂等）。</p>
<section>
  <h2>① Cloudflare 凭证</h2>
  ${oauthNote}
  ${authNote}
  ${authDetails(hint)}
  <form id="form-auth"><label>API Token <input type="password" name="token" autocomplete="off"></label>
  <button type="submit">下一步</button> <span class="err" id="err-auth"></span></form>
</section>
<section>
  <h2>② 团队入口域名</h2>
  <form id="form-domain">
    <label><input type="radio" name="choice" value="workers" checked> workers.dev 免费域名（推荐起步）</label>
    <label><input type="radio" name="choice" value="custom"> 自有域名 <input type="text" name="domain" placeholder="team.example.com"></label>
    <button type="submit">下一步</button> <span class="err" id="err-domain"></span>
  </form>
</section>
<section>
  <h2>③ 启用模块</h2>
  <form id="form-modules"><label>逗号分隔 <input type="text" name="modules" value="${state.modules.join(',')}"></label>
  <button type="submit">下一步</button> <span class="err" id="err-modules"></span></form>
</section>
<section>
  <h2>④ 装配</h2>
  <p id="confirm-line">域名：${state.domainChoice === 'custom' ? state.domain : 'workers.dev 免费域'}；模块：${state.modules.join('、')}</p>
  <button id="btn-deploy" type="button">开始装配（九步）</button>
  <pre id="events"></pre>
  <p class="err" id="err-deploy"></p>
</section>
</main>
<script>
const $ = (id) => document.getElementById(id);
for (const b of document.querySelectorAll('button.copy')) {
  b.addEventListener('click', () => navigator.clipboard.writeText($(b.dataset.copy).textContent));
}
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, data: await res.json() };
}
function showErr(id, problem) { $(id).textContent = problem ?? ''; }
$('form-auth').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await post('/api/step1', { token: e.target.token.value });
  r.ok ? location.reload() : showErr('err-auth', r.data.problem);
});
$('form-domain').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await post('/api/step2', { choice: e.target.choice.value, domain: e.target.domain.value });
  r.ok ? location.reload() : showErr('err-domain', r.data.problem);
});
$('form-modules').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await post('/api/step3', { modules: e.target.modules.value.split(',') });
  r.ok ? location.reload() : showErr('err-modules', r.data.problem);
});
$('btn-deploy').addEventListener('click', async () => {
  $('btn-deploy').disabled = true;
  const r = await post('/api/step4', {});
  if (!r.ok) { showErr('err-deploy', r.data.problem); $('btn-deploy').disabled = false; return; }
  const es = new EventSource('/api/events');
  es.onmessage = (m) => { $('events').textContent += m.data + '\\n'; };
  const timer = setInterval(async () => {
    const s = await (await fetch('/api/state')).json();
    if (s.step === 'done') { clearInterval(timer); es.close(); $('events').textContent += '\\n完成：' + s.result.baseUrl + (s.result.setupUrl ?? ''); }
    if (s.step === 'failed') { clearInterval(timer); es.close(); showErr('err-deploy', s.error.cause); // MUTANT-4 删修复行 $('btn-deploy').disabled = false; }
  }, 800);
});
</script>
</body>
</html>`;
}

/** 建向导服务（不 listen；端口由调用方/测试决定）。 */
export function createWizardServer(opts: ServeOptions): Server {
  const { deps } = opts;
  // 宿主环境提示：初始由 deps 注入（#246）；② 选自有域后就地更新 needsTotalTls，不改调用方对象。
  let envHint = resolveEnvHint(deps);
  const sseClients = new Set<ServerResponse>();
  const broadcast = (text: string): void => {
    for (const res of sseClients) {
      try {
        res.write(`data: ${text}\n\n`);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  return createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const state = deps.getState();
      try {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderPage(state, envHint));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/state') {
          // ⑥ 幂等重跑标语随状态查询返回；状态投影永不含 token 明文（envHint 只有布尔字段）。
          json(res, 200, {
            ...state,
            hasEnv: envHint.hasEnvToken,
            envHint,
            idempotent: true,
            idempotentNote: '任何时候重跑收敛同一终态',
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/events') {
          // SSE：历史事件一次性快照推送，不挂长连接（测试与轮询态都确定收敛）。
          // 浏览器页面靠 800ms 轮询 /api/state 判断 done/failed；事件明细轮询本端点全量重拉。
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('retry: 2000\n\n');
          for (const e of state.events) res.write(`data: [${e.i}] ${e.text}\n\n`);
          res.end();
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/step1') {
          if (state.hasToken) {
            json(res, 200, { step: state.step });
            return;
          }
          const body = await readJsonBody(req);
          const r = submitToken(state, String(body.token ?? ''));
          if (r.problem) {
            json(res, 400, { problem: r.problem });
            return;
          }
          deps.setState(r.state);
          json(res, 200, { step: r.state.step });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/step2') {
          if (!state.hasToken) {
            json(res, 400, { problem: '请先完成①凭证' });
            return;
          }
          const body = await readJsonBody(req);
          const choice = body.choice === 'custom' ? 'custom' : 'workers';
          const r = chooseDomain(state, choice, String(body.domain ?? ''));
          if (r.problem) {
            json(res, 400, { problem: r.problem });
            return;
          }
          deps.setState(r.state);
          // #246：自有域 → 更新 needsTotalTls（apexZone 猜 zone 只做向导提示；部署期以真实 zone 查询为准）。
          if (r.state.domainChoice === 'custom') {
            envHint = {
              ...envHint,
              needsTotalTls: needsTotalTls(r.state.domain, apexZone(r.state.domain)),
            };
          }
          json(res, 200, { step: r.state.step });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/step3') {
          if (!state.hasToken) {
            json(res, 400, { problem: '请先完成①凭证' });
            return;
          }
          const body = await readJsonBody(req);
          const mods = Array.isArray(body.modules)
            ? (body.modules as unknown[]).map(String)
            : String(body.modules ?? '').split(',');
          const r = confirmModules(state, mods);
          if (r.problem) {
            json(res, 400, { problem: r.problem });
            return;
          }
          deps.setState(r.state);
          json(res, 200, { step: r.state.step });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/step4') {
          if (state.step !== 'ready' && state.step !== 'failed' && state.step !== 'done') {
            json(res, 400, { problem: `当前步骤 ${state.step} 不能开始装配（请先完成①②③）` });
            return;
          }
          // ⑥ 幂等重跑：failed/done 重开前先 reset 回干净状态（token 明文本就不留存，重填）。
          const base = state.step === 'ready' ? state : resetWizard(state);
          const st = beginDeploy({ ...base, hasToken: true, domainChoice: base.domainChoice ?? (base.domain ? 'custom' : 'workers') });
          deps.setState(st);
          void deps
            .deploy({
              domain: st.domain,
              modules: st.modules,
              storage: { provider: 'r2', bucket: 'unself-storage' },
              onEvent: (text) => {
                // pushEvent 原地追加到当前状态（返回值是事件对象，不是状态——不能拿去 setState）。
                const cur = deps.getState();
                pushEvent(cur, { kind: 'log', text });
                deps.setState(cur);
                broadcast(text);
              },
            })
            .then((r) => {
              const cur = deps.getState();
              deps.setState(
                completeDeploy(cur, { baseUrl: r.baseUrl, setupUrl: r.setupToken ? `/setup?token=${r.setupToken}` : null }),
              );
              broadcast(`✓ 装配完成：${r.baseUrl}`);
            })
            .catch((err: unknown) => {
              const cur = deps.getState();
              deps.setState(failDeploy(cur, advise(err)));
              broadcast(`✗ ${err instanceof Error ? err.message : String(err)}`);
            });
          json(res, 202, { step: 'deploying' });
          return;
        }
        json(res, 404, { problem: `未知路径 ${url.pathname}` });
      } catch (err) {
        json(res, 500, { problem: String(err instanceof Error ? err.message : err) });
      }
    })();
  });
}

/** 启动向导（CLI 用）：listen 随机/指定端口，返回实际端口。 */
export async function startWizardServer(opts: ServeOptions): Promise<{ server: Server; port: number }> {
  const server = createWizardServer(opts);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('listen 失败：无端口'));
    });
  });
  return { server, port };
}

export type { WizardState };
