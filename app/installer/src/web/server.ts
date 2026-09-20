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
  addModule,
  apexZone,
  beginDeploy,
  chooseDomain,
  chooseStorage,
  collectConfigValues,
  completeDeploy,
  confirmModules,
  deployModules,
  failDeploy,
  finishModuleConfig,
  needsTotalTls,
  pushEvent,
  resetWizard,
  saveConfigValues,
  submitOAuthSkip,
  submitToken,
  type WizardEnvHint,
  type WizardModuleAdd,
  type WizardModuleConfig,
  type WizardResourceName,
  type WizardState,
  type WizardStorageOption,
} from './state';
import { renderPage } from './page';
export { renderPage };

/** deps.moduleConfigs 未接线时的缺省（全部模块无配置页 → ③★ 自动跳过）。 */
const EMPTY_CONFIGS: WizardModuleConfig[] = [];

/**
 * ③★ 部署时合并配置值（#307）：非 secret 从 state.configValues（default 兑底），
 * secret 从进程内存 configSecrets 注入。合并结果只进本次 deps.deploy 调用参数
 * （TODO(#307 后续)：引擎消费写进模块 vars/secrets），不落盘不回显。
 */
function mergeConfigValues(
  st: WizardState,
  configSecrets: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  const merged = collectConfigValues(st);
  for (const [modId, values] of Object.entries(merged)) {
    for (const [k, v] of Object.entries(configSecrets[modId] ?? {})) {
      if (v) values[k] = v;
    }
  }
  return merged;
}

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
    /** 模块条目（#269/#77）：一律对象形态（官方模块写 npm 串；已无 builtin 裸字符串）。 */
    modules: Array<{ id: string; source: string }>;
    /**
     * ③★ 模块配置值（#307）：模块 id → { key: 值 }（含 secret，值只进本次调用内存）。
     * TODO(#307 后续)：引擎侧消费（写进模块 wrangler vars / wrangler secret），另开任务。
     */
    configValues?: Record<string, Record<string, string>>;
    /** ③½ 用户存储选择（#55）：模块 id → 四级之一；缺省模块 = preferred ?? core。 */
    storageChoices?: Record<string, string>;
    storage: { provider: 'r2'; bucket: string };
    onEvent: (text: string) => void;
    /** 向导①粘贴的 token（#272）：只进本次部署调用内存，不落盘不回显。 */
    token?: string;
    /** 撞车守卫放行开关（#272）：④ 显式勾选「允许接管」。 */
    allowAdopt?: boolean;
    /** 来源漂移已确认（#269）：③ 已展示将要装什么且用户确认。 */
    yes?: boolean;
  }) => Promise<{ baseUrl: string; setupToken: string | null }>;
  /**
   * ③ 来源解析（#269）：把安装串解析成「将要装什么」（调引擎 previewModuleSource）。
   * 未知能力等门禁失败 → 抛人话 Error（点名能力）；壳转 400 展示。
   * 缺省 = 未接线（旧调用方/测试）→ ③ 添加来源入口提示不可用。
   */
  resolveModule?: (source: string) => Promise<WizardModuleAdd>;
  /**
   * ① token 真验（#269）：`GET /user/tokens/verify`（CLI 注入；缺省 = 跳过真验）。
   * 返回 ok=false 时壳把 message 展示在①（区分「token 无效」与网络/权限问题）。
   */
  verifyToken?: (token: string) => Promise<{ ok: boolean; message: string }>;
  /**
   * ③★ 模块配置声明（#307）：选中且声明了 config 的模块清单（每模块一页的依据）。
   * 由启动方注入（CLI 从模块包 manifest 读；测试直给）；缺省 = 全部模块无配置页（③★ 自动跳过）。
   */
  moduleConfigs?: WizardModuleConfig[];
  /** ③ 改模块后重算资源名预览（#269；缺省 = 沿用启动时快照）。 */
  previewResources?: (moduleIds: string[]) => Promise<WizardResourceName[]>;
  /**
   * ③★ 改模块后重算配置声明（#307；缺省 = 沿用 deps.moduleConfigs 注入值）。
   * CLI 从模块包 manifest 读（本地解析，不联网）；测试直给。
   */
  refreshModuleConfigs?: (moduleIds: string[]) => Promise<WizardModuleConfig[]>;
  /**
   * ② zone 自动发现（#307）：用 ① 的凭证列账户 active zone。
   * token 传 '' = 引擎默认凭证优先级（本机 wrangler OAuth）；拿不到返回 ok:false（UI 走手填回退）。
   * CLI 缺省注入 wizardListZones（deploy.ts）；测试直给替身。
   */
  listZones?: (token: string) => Promise<{ ok: boolean; zones: Array<{ id: string; name: string }>; message: string }>;
  /**
   * ③★ 测试连接（#307）：服务端代理验证字段值可达（test:'http' 才有真测试；其他标识前端渲染禁用按钮）。
   * CLI 缺省注入 testHttpEndpoint；测试直给替身。返回 ok + 人话 message（不透传内部细节）。
   */
  testConnection?: (url: string) => Promise<{ ok: boolean; message: string }>;
  /**
   * 模块存储声明投影（#55）：③½ 渲染单选 + accepts 校验的依据。
   * 由启动方注入（CLI 从模块包 manifest 读；测试直给）；缺省 = 无可选模块（全按 preferred ?? core）。
   */
  storageOptions?: WizardStorageOption[];
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

/** 失败三要素（与引擎 errors.advise（src/engine）同款映射，已知的才归类，其余归 code 给幂等重跑）。 */
function advise(err: unknown): { cause: string; owner: 'token' | 'dns' | 'network' | 'code'; fix: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (/10405/.test(msg)) return { cause: msg.slice(0, 300), owner: 'token', fix: 'token 缺 Zone 级权限：按向导①的深链接重建 token 后重跑' };
  if (/ENOTFOUND|无法获取/.test(msg)) return { cause: msg.slice(0, 300), owner: 'dns', fix: 'DNS 未生效：等 60 秒重跑（幂等，只补没完成的部分）' };
  if (/fetch failed|ECONNRESET|ETIMEDOUT/.test(msg)) return { cause: msg.slice(0, 300), owner: 'network', fix: '网络中断或临时故障：检查网络后重跑' };
  return { cause: msg.slice(0, 300), owner: 'code', fix: '直接重跑即可：装配器幂等收敛，不会重复创建资源' };
}

/**
 * 向导页的令牌变量块：取值来自契约默认主题（`core/contracts/src/theme-tokens.json`
 * 是令牌取值的唯一定义处），页面样式一律引用 `var(--unself-*)`——照 AGENTS「样式只走 tokens」。
 * 源码里不出现任何颜色字面量（取值在运行时由数据渲染出来），故 verify-tokens 规则一通过。
 */
export function themeVarBlock(): string {
  return Object.entries(DEFAULT_THEME)
    .map(([dotted, value]) => `${tokenCssName(dotted)}: ${value};`)
    .join(' ');
}


/** 建向导服务（不 listen；端口由调用方/测试决定）。 */
export function createWizardServer(opts: ServeOptions): Server {
  const { deps } = opts;
  // 宿主环境提示：初始由 deps 注入（#246）；② 选自有域后就地更新 needsTotalTls，不改调用方对象。
  let envHint = resolveEnvHint(deps);
  // 向导①粘贴的 token（#272）：只活在本次服务进程内存（不写 state、不进 /api/state、不落盘不回显）。
  // ⑥ 重跑（reset）时清空，与状态机「token 明文不留存」语义一致。
  let sessionToken: string | null = null;
  // ③★ secret 配置值（#307）：模块 id → key → 值。同 #272 token 纪律：只进本进程内存，
  // 不写 state（publicState 自然不投影）、不落盘、不回显；⑥ reset 与 step4 重开时清空。
  let configSecrets: Record<string, Record<string, string>> = {};
  const clearConfigSecrets = (): void => {
    configSecrets = {};
  };
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
          // ⑥ 幂等重跑标语随状态查询返回；状态投影永不含 token 明文与 ③★ secret 值
          //（secret 只在服务进程内存 configSecrets；configValues 只收非 secret——双层不泄漏）。
          json(res, 200, {
            ...state,
            hasEnv: envHint.hasEnvToken,
            envHint,
            idempotent: true,
            idempotentNote: '任何时候重跑收敛同一终态',
          });
          return;
        }
        // ② zone 自动发现（#307）：用 ① 的凭证列账户 active zone（无凭证/失败 → ok:false 走手填回退）。
        if (req.method === 'GET' && url.pathname === '/api/zones') {
          if (!deps.listZones) {
            json(res, 200, { ok: false, zones: [], message: '本次向导启动未接线 zone 发现：请手填完整域名' });
            return;
          }
          const r = await deps.listZones(sessionToken ?? '');
          json(res, 200, r);
          return;
        }
        // ③★ 模块配置声明（#307）：渲染每模块配置页的依据（只声明元数据，无值）。
        if (req.method === 'GET' && url.pathname === '/api/module-configs') {
          json(res, 200, { configs: state.moduleConfigs ?? EMPTY_CONFIGS });
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
          const raw = String(body.token ?? '');
          // 「可零输入直跑」的接线（让 #246 的文案与行为一致）：宿主探测到可用 wrangler OAuth
          // 且非 CI → 留空 = 用本机 OAuth 凭据（引擎按凭证优先级自取），不再报「token 为空」。
          if (raw.trim() === '' && envHint.oauthUsable && !envHint.ci) {
            sessionToken = '';
            const skipped = submitOAuthSkip(state);
            deps.setState(skipped);
            json(res, 200, { step: skipped.step });
            return;
          }
          const r = submitToken(state, raw);
          if (r.problem) {
            json(res, 400, { problem: r.problem });
            return;
          }
          const token = raw.trim();
          // #269 真验（CF `GET /user/tokens/verify`）：形状只拦明显不对；无效 token 显示 CF 原话，
          // 网络/权限问题与「token 无效」分开报。失败不进 ②。
          if (deps.verifyToken) {
            const v = await deps.verifyToken(token);
            if (!v.ok) {
              json(res, 400, { problem: v.message });
              return;
            }
          }
          // #272 接线：token 只留在本次服务内存（sessionToken），由 ④ 部署调用传给引擎。
          sessionToken = token;
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
          // #307：③★ 步进门禁按「注入声明 ∩ 本次提交清单」——先合成带声明的判定态再确认。
          const declared = deps.refreshModuleConfigs
            ? await deps.refreshModuleConfigs(mods)
            : (deps.moduleConfigs ?? EMPTY_CONFIGS).filter((c) => mods.includes(c.id));
          const r = confirmModules({ ...state, moduleConfigs: declared }, mods);
          if (r.problem) {
            json(res, 400, { problem: r.problem });
            return;
          }
          // #269：③ 改了模块清单 → 资源名预览重算（不再沿用启动时快照）。
          // #307：③★ 配置声明同步重算（模块清单变化 → 每模块一页清单变化）。
          // 步进语义：confirmModules 已按重算声明判定 module-config / storage；这里只落数据。
          const next = {
            ...r.state,
            moduleConfigs: declared,
            ...(deps.previewResources
              ? { resourceNames: await deps.previewResources(r.state.modules) }
              : {}),
          };
          deps.setState(next);
          json(res, 200, { step: next.step });
          return;
        }
        // ③ 添加来源模块（#269）：解析安装串 → 权限门禁（未知能力报名字）→ 并入清单 + 落点单选。
        if (req.method === 'POST' && url.pathname === '/api/step3/add') {
          if (!state.hasToken) {
            json(res, 400, { problem: '请先完成①凭证' });
            return;
          }
          if (!deps.resolveModule) {
            json(res, 400, {
              problem: '本次向导启动未接线来源解析：请用 CLI `unself module add <来源>`（或升级安装器）',
            });
            return;
          }
          const body = await readJsonBody(req);
          const source = String(body.source ?? '').trim();
          if (!source) {
            json(res, 400, { problem: '安装串为空：形如 npm:@unself/hello@0.1.0 / npm:@acme/unself-todo@1.2.0 / file:./modules/x' });
            return;
          }
          let preview: WizardModuleAdd;
          try {
            preview = await deps.resolveModule(source);
          } catch (err) {
            json(res, 400, { problem: err instanceof Error ? err.message : String(err) });
            return;
          }
          const r = addModule(state, preview);
          if (r.problem) {
            json(res, 400, { problem: r.problem });
            return;
          }
          // #307：③★ 配置声明同步重算（新模块可能带 config 声明——resolveModule 投影或 refresh 注入）。
          const next = {
            ...r.state,
            moduleConfigs: deps.refreshModuleConfigs
              ? await deps.refreshModuleConfigs(r.state.modules)
              : [
                  ...(deps.moduleConfigs ?? EMPTY_CONFIGS).filter((c) => r.state.modules.includes(c.id)),
                  ...(preview.configFields ? [{ id: preview.id, fields: preview.configFields }] : []),
                ],
            ...(deps.previewResources
              ? { resourceNames: await deps.previewResources(r.state.modules) }
              : {}),
          };
          deps.setState(next);
          json(res, 200, { step: next.step, id: preview.id });
          return;
        }
        // ③★ 模块配置（#307）：逐模块保存非 secret 值；secret 值进进程内存（同 #272 token 纪律）。
        // 逐模块一页：每模块提交一次（modId + 全字段值）；全部声明模块都保存过后前端再发 finish。
        if (req.method === 'POST' && url.pathname === '/api/step3c') {
          if (!state.hasToken) {
            json(res, 400, { problem: '请先完成①凭证' });
            return;
          }
          const body = await readJsonBody(req);
          const modId = String(body.modId ?? '');
          const raw = (body.values ?? {}) as Record<string, unknown>;
          const values: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw)) values[k] = String(v);
          // secret 字段从值里抽出进进程内存（不进 state）；非 secret 走纯函数落 state。
          const cfg = state.moduleConfigs.find((m) => m.id === modId);
          if (!cfg) {
            json(res, 400, { problem: `模块 ${modId} 没有 config 声明：无配置页（③★ 只收声明过的模块）` });
            return;
          }
          for (const f of cfg.fields) {
            if (f.type !== 'secret') continue;
            const v = (values[f.key] ?? '').trim();
            if (f.required && !v) {
              json(res, 400, { problem: `「${f.label}」为必填项` });
              return;
            }
            if (v) {
              configSecrets[modId] = { ...(configSecrets[modId] ?? {}), [f.key]: v };
            }
            delete values[f.key]; // 从非 secret 通路剥离
          }
          const r = saveConfigValues(state, modId, values);
          if (r.problem) {
            json(res, 400, { problem: r.problem });
            return;
          }
          deps.setState(r.state);
          json(res, 200, { step: r.state.step, saved: modId });
          return;
        }
        // ③★ 完成（#307）：全部声明模块已收齐 → 进 ③½。secret 必填在此总检（进程内存值在才算收齐）。
        if (req.method === 'POST' && url.pathname === '/api/step3c/finish') {
          if (!state.hasToken) {
            json(res, 400, { problem: '请先完成①凭证' });
            return;
          }
          for (const cfg of state.moduleConfigs) {
            for (const f of cfg.fields) {
              if (f.type !== 'secret' || !f.required) continue;
              if (!(configSecrets[cfg.id]?.[f.key] ?? '').trim()) {
                json(res, 400, { problem: `模块 ${cfg.id} 的「${f.label}」还没填（必填）` });
                return;
              }
            }
          }
          const r = finishModuleConfig(state);
          if (r.problem) {
            json(res, 400, { problem: r.problem });
            return;
          }
          deps.setState(r.state);
          json(res, 200, { step: r.state.step });
          return;
        }
        // ③★ 测试连接（#307）：服务端代理验证字段值可达（同 /api/oidc/test-connection 模式）。
        // 只收 URL（test:'http' 字段）；不透传内部错误细节，成功/失败都给人话。
        if (req.method === 'POST' && url.pathname === '/api/config-test') {
          if (!deps.testConnection) {
            json(res, 200, { ok: false, message: '本次向导启动未接线连接测试：装配时会验证' });
            return;
          }
          const body = await readJsonBody(req);
          const urlRaw = String(body.url ?? '').trim();
          if (!/^https?:\/\//.test(urlRaw)) {
            json(res, 200, { ok: false, message: '请先填一个 http(s) 地址再测试' });
            return;
          }
          const r = await deps.testConnection(urlRaw);
          json(res, 200, r);
          return;
        }
        // ③½ 存储选择（#55）：逐模块从 accepts 里选，选外即拒绝；shared 需知情同意。
        if (req.method === 'POST' && url.pathname === '/api/step3b') {
          if (!state.hasToken) {
            json(res, 400, { problem: '请先完成①凭证' });
            return;
          }
          const body = await readJsonBody(req);
          const raw = (body.choices ?? {}) as Record<string, unknown>;
          const choices: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw)) choices[k] = String(v);
          const r = chooseStorage(state, choices, body.sharedConsent === true);
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
          if (state.step !== 'ready') {
            sessionToken = null; // reset 连带丢弃上一轮粘贴的 token
            clearConfigSecrets(); // ③★ secret 值同样只服务一轮（重跑重填，同 token 语义）
          }
          const body = await readJsonBody(req);
          const allowAdopt = body.allowAdopt === true;
          const st = beginDeploy({ ...base, hasToken: true, domainChoice: base.domainChoice ?? (base.domain ? 'custom' : 'workers') });
          deps.setState(st);
          void deps
            .deploy({
              domain: st.domain,
              // #269：③ 添加的来源模块以 {id, source} 进装配；builtin 仍为字符串。
              modules: deployModules(st),
              storageChoices: Object.keys(st.storageChoices).length > 0 ? { ...st.storageChoices } : undefined,
              storage: { provider: 'r2', bucket: 'unself-storage' },
              // #269：③ 已在装配前展示「将要装什么」且用户点确认 → 来源漂移视为已确认（#245 闸门不⭕）。
              yes: true,
              // #307 ③★：模块配置值进部署调用（secret 从进程内存合并，非 secret 从 state）。
              // TODO(#307 后续)：引擎侧消费——把值写进模块 wrangler vars / wrangler secret
              //（引擎 RunNineStepsOptions 扩展 configValues + secret 分流，另开任务）。
              configValues: mergeConfigValues(st, configSecrets),
              ...(sessionToken ? { token: sessionToken } : {}),
              ...(allowAdopt ? { allowAdopt: true } : {}),
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
