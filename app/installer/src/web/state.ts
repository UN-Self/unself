// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web 向导状态机（#242/#70：六段流语义，载体 = 本地 Web 页）：
 * ① 认证（token 填密码框，形态校验，可重试）→ ② 域名（workers.dev 显式第一项 / 自有域体检）
 * → ③ 模块确认 → ④ 九步进度（事件流，失败三要素：原因/归属/修复）→ ⑤ 收尾下一步（setup 链接）
 * → ⑥ 幂等重跑（reset 回 ①，任何时候重跑收敛同一终态）。
 * 纯状态机：不碰 node:* 与网络；token 只记 hasToken，明文不进状态（页面/JSON 均不可回读）。
 */
import { DEFAULT_MODULE_IDS, isOfficialModule, officialModuleEntry } from '../lib/official-modules';

/** 向导步骤（①→⑥ 对应 auth→…→done/failed，reset 回 auth）。
 * #307：'module-config' = ③★ 模块配置（有 config 声明的选中模块逐模块一页，步序 modules 之后/storage 之前；
 * 无 config 声明的模块自动跳过——跳过表现为不落在该步，而非词表缺席）。 */
export type WizardStep = 'auth' | 'domain' | 'modules' | 'module-config' | 'storage' | 'ready' | 'deploying' | 'done' | 'failed';

/** 失败三要素（语义同引擎 src/engine/errors.advise）。 */
export interface WizardError {
  cause: string;
  owner: 'token' | 'dns' | 'network' | 'code';
  fix: string;
}

/** 进度事件（④：转发 runNineSteps 的 reporter 语义）。 */
export interface WizardEvent {
  i: number;
  kind: 'step' | 'log' | 'ok' | 'fail' | 'done';
  n?: number;
  title?: string;
  text: string;
}

/** 数据四级（决策 #55）：模块存储落点词表。 */
export type StorageLevel = 'core' | 'shared' | 'dedicated' | 'external';

/** 模块存储声明（manifest.storage 的向导投影）：用户从 accepts 里选。 */
export interface WizardStorageOption {
  id: string;
  accepts: StorageLevel[];
  preferred?: StorageLevel;
}

/** 资源名预览项（#272：向导页展示本实例会占用哪些 CF 资源名）。 */
export interface WizardResourceName {
  kind: string;
  name: string;
}

/**
 * ③ 添加的第三方模块（#269）：来源入口的解析结果（来源/版本/SRI/permissions/落点）。
 * 只存展示与装配所需字段；manifest 原文不进状态（体积 + 无回读价值）。
 */
export interface WizardModuleAdd {
  id: string;
  source: string;
  /** 来源协议（npm/github/https/file；#77 已无 official）。 */
  kind: string;
  version: string;
  /** 包字节 SRI（sha512-…）；目录形态无下载字节时省略。 */
  integrity?: string;
  permissions: string[];
  storageAccepts: StorageLevel[];
  storagePreferred?: StorageLevel;
  /** manifest 规范化哈希（进 lock 前展示用；不落盘）。 */
  manifestHash: string;
  /**
   * ③★ config 声明投影（#307）：resolveModule 解析时顺带投影（manifest.config 原样投影，
   * default 归一字符串）。缺省 = 无配置页（模块未声明 config）。
   */
  configFields?: WizardConfigField[];
}

/**
 * 模块配置字段声明（#307 ③★）：manifest.config 的向导投影（契约 ModuleConfigField 的最小投影面）。
 * 渲染与校验只看这些字段；default 存字符串形态（boolean/json 序列化后进页面 data-*）。
 */
export interface WizardConfigField {
  key: string;
  label: string;
  type: 'string' | 'secret' | 'number' | 'boolean' | 'enum' | 'url' | 'json' | 'oauth';
  required?: boolean;
  /** 缺省值（统一字符串形态；boolean = 'true'/'false'，json = 原文串）。 */
  default?: string;
  options?: string[];
  test?: string;
}

/** 投影字段 = 输入形状（deps 注入用别名；投影不另造形状）。 */
export type WizardConfigFieldInput = WizardConfigField;

/** 单个选中模块的 config 声明投影（#307）：无 config 的模块不出现。 */
export interface WizardModuleConfig {
  id: string;
  fields: WizardConfigField[];
}

/** 数据四级中需要知情同意的级别（#55：shared = 共享库完整访问权 + 零隔离）。 */
export const SHARED_CONSENT_NOTE =
  '该模块将在共享数据库中自建表：它将获得共享数据库的完整访问权（与其他模块零隔离）；' +
  '表名以模块 id 为前缀，禁止跨模块外键（三护栏由装配器硬校验）。';

/** 部署结果（⑤ 收尾：baseUrl + setup 深链）。 */
export interface WizardResult {
  baseUrl: string;
  /** setup token 存在时给 /setup?token=… 深链；sealed（已有管理员）为 null。 */
  setupUrl: string | null;
}

/**
 * 宿主环境提示（#246 决策 #66/#67）：server 启动方（CLI/测试）注入合成结论，
 * 向导壳不读 process.env、不 import 引擎（oauthCallbackReachable 等探测在启动方做）。
 */
export interface WizardEnvHint {
  /** CLOUDFLARE_API_TOKEN 已设（环境已带凭证）。 */
  hasEnvToken: boolean;
  /** wrangler OAuth 借用可用（启动时用 oauthCallbackReachable + wrangler 探测的合成结论）。 */
  oauthUsable: boolean;
  /** 用户配置了多级子域（域名选择后可更新；初态 false）。 */
  needsTotalTls: boolean;
  /** 无 TTY / CI。 */
  ci: boolean;
}

export interface WizardState {
  step: WizardStep;
  /** 实例目录绝对路径（页头常驻显示，可复制）。 */
  instancePath: string;
  /** 是否已提交 token（只有布尔，明文不进状态）。 */
  hasToken: boolean;
  domainChoice: 'workers' | 'custom' | null;
  /** 自有域原文；workers.dev 语义时为空串。 */
  domain: string;
  /** 确认启用的模块 id。 */
  modules: string[];
  /** 模块存储声明投影（③ 步渲染单选；空 = 全部按 preferred ?? core）。 */
  storageOptions: WizardStorageOption[];
  /** 添加的第三方模块（#269）：来源 + 解析后的版本/SRI/permissions/落点。 */
  moduleAdds: WizardModuleAdd[];
  /**
   * ③★ 模块配置声明投影（#307）：只含「有 config 声明且已选中」的模块；
   * 由向导服务在 modules/step3/add 后重算（deps.moduleConfigs），渲染与提交校验的依据。
   * secret 字段声明可进投影（只声明元数据，不含值）；**值**分两路：secret 进服务内存 configSecrets，
   * 非 secret 进 state.configValues（可投影）。
   */
  moduleConfigs: WizardModuleConfig[];
  /**
   * ③★ 非 secret 配置值（#307）：模块 id → key → 值（统一字符串形态）。
   * secret 值永不进这里（进程内存 configSecrets 同 #272 token 纪律）。
   */
  configValues: Record<string, Record<string, string>>;
  /** 本实例会占用的 CF 资源名（#272 预览；来自实例配置的命名空间派生）。 */
  resourceNames: WizardResourceName[];
  /** 用户对每模块的存储选择（#55）；缺省模块 = preferred ?? core。 */
  storageChoices: Record<string, StorageLevel>;
  /** shared 知情同意已勾选（有模块选 shared 时必须 true 才能进 ④）。 */
  sharedConsent: boolean;
  events: WizardEvent[];
  error: WizardError | null;
  result: WizardResult | null;
}

/** 初始状态（① auth）。instancePath 必填——页头常驻可见（决策 #53）。 */
export function initialWizardState(
  instancePath: string,
  options?: {
    modules?: string[];
    storageOptions?: WizardStorageOption[];
    resourceNames?: WizardResourceName[];
    moduleAdds?: WizardModuleAdd[];
  },
): WizardState {
  const storageOptions = options?.storageOptions ?? [];
  const moduleAdds = options?.moduleAdds ?? [];
  return {
    step: 'auth',
    instancePath,
    hasToken: false,
    domainChoice: null,
    domain: '',
    modules: options?.modules ?? [...DEFAULT_MODULE_IDS],
    storageOptions,
    moduleAdds,
    moduleConfigs: [],
    configValues: {},
    resourceNames: options?.resourceNames ?? [],
    storageChoices: {},
    sharedConsent: false,
    events: [],
    error: null,
    result: null,
  };
}

/** push 一条事件（编号自增）。 */
export function pushEvent(s: WizardState, e: Omit<WizardEvent, 'i'>): WizardEvent {
  const ev: WizardEvent = { ...e, i: s.events.length };
  s.events.push(ev);
  return ev;
}

/**
 * token 形态校验（决策 #251/#269）：只拦「明显不对」，真伪交给 CF `GET /user/tokens/verify`。
 * 依据 CF《Token formats》（2026-04-20）：老格式 = 40 位字母数字（首字符可能是数字），
 * 新格式 = `cfut_` + 40 字符 + 校验和——规格里**没有「必须字母开头」**，长度也不固定，
 * 所以这里只做「非空 + 无空白 + 字符集 [A-Za-z0-9_-]」，不再猜形状。返回 null = 交给真验。
 */
export function tokenProblem(token: string): string | null {
  const t = token.trim();
  if (!t) return 'token 为空';
  if (/\s/.test(t)) return 'token 里含空格/换行：可能是复制带了空白或粘了两段，请重新整段复制粘贴';
  if (!/^[A-Za-z0-9_-]+$/.test(t)) return 'token 含字母、数字、连字符、下划线以外的字符：请确认复制的是 API Token 本身（不是邮箱/Notation/密钥 JSON）';
  return null;
}

/**
 * ① 用本机 wrangler OAuth 直跑（页面上「检测到本机 wrangler OAuth，可零输入直跑（跳过本步）」）：
 * 留空即视为使用 OAuth——引擎按凭证优先级自取 wrangler 凭据（决策 #67），向导只把
 * 「空 token」这个意图显式化，不落任何秘密。
 */
export function submitOAuthSkip(s: WizardState): WizardState {
  return { ...s, hasToken: true, step: 'domain', error: null };
}

/** ① 提交 token：合法 → hasToken=true 进 ②；非法 → 原地不动带错误。 */
export function submitToken(s: WizardState, token: string): { state: WizardState; problem: string | null } {
  const problem = tokenProblem(token);
  if (problem) return { state: s, problem };
  return { state: { ...s, hasToken: true, step: 'domain', error: null }, problem: null };
}

/**
 * 域名形态体检（语义同 interactive.domainProblem）：至少一个点、段规则。
 * 返回 null = 合法。
 */
export function domainProblem(domain: string): string | null {
  const d = domain.trim();
  if (!d) return '域名为空';
  if (!d.includes('.')) return `「${d}」不像完整域名：至少要带一个点（如 team.example.com），裸名字没法配 DNS`;
  for (const label of d.split('.')) {
    if (label === '') return '域名里有连续的点（空段）';
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) {
      return `「${label}」这段不合法：每段只能用字母、数字、连字符（-），且连字符不能开头或结尾`;
    }
  }
  return null;
}

/** ② 域名三选（workers.dev 显式第一项）：choice=workers → domain 留空语义。 */
export function chooseDomain(
  s: WizardState,
  choice: 'workers' | 'custom',
  domain?: string,
): { state: WizardState; problem: string | null } {
  if (choice === 'workers') {
    return { state: { ...s, domainChoice: 'workers', domain: '', step: 'modules' }, problem: null };
  }
  const problem = domainProblem(domain ?? '');
  if (problem) return { state: s, problem };
  return { state: { ...s, domainChoice: 'custom', domain: (domain ?? '').trim(), step: 'modules' }, problem: null };
}

/**
 * 多级子域判定（#246 决策 #66：Universal SSL 只盖 apex + 一级通配（*.zone），更深的要 Total TLS）。
 * 判定式与语义同引擎 src/engine/steps.needsTotalTls——#303 后壳与引擎同包，此处的内联副本应改为直接引用（待「打磨部署动线」时一并收）。
 */
export function needsTotalTls(domain: string, zone: string): boolean {
  return domain.split('.').length > zone.split('.').length + 1;
}

/**
 * 从自有域猜测其 zone（apex）：取末两段（如 a.team.example.com → example.com）。
 * 只用于向导①折叠入口的默认展开提示；部署期以真实 zone 查询为准（引擎侧判定不变）。
 */
export function apexZone(domain: string): string {
  const labels = domain.trim().split('.').filter((l) => l.length > 0);
  return labels.slice(-2).join('.');
}

/**
 * ③ 模块确认：非空 id 清单（去空格去重）；空清单不合法。
 * #77：每个 id 必须有来源——官方模块（走 npm 串）或用「添加模块」加过的来源模块；
 * 两者都不是就当场拒（不再有「裸 id = builtin 目录」的隐式来源）。
 */
export function confirmModules(s: WizardState, modules: string[]): { state: WizardState; problem: string | null } {
  const ids = [...new Set(modules.map((m) => m.trim()).filter((m) => m.length > 0))];
  if (ids.length === 0) return { state: s, problem: '至少确认一个模块（或回到配置文件改 modules）' };
  for (const id of ids) {
    if (!/^[a-z][a-z0-9-]+$/.test(id)) return { state: s, problem: `模块 id 不合法：${id}（小写字母开头，小写字母/数字/连字符）` };
    if (!isOfficialModule(id) && !s.moduleAdds.some((a) => a.id === id)) {
      return {
        state: s,
        problem:
          `模块 ${id} 不是官方模块，也没有来源：请先用「添加模块」填安装串` +
          '（npm:@acme/pkg@1.2.0 / github:acme/pkg#v1.0.0 / https://…/x.tgz / file:./modules/x）' +
          '——决策 #77 起没有 official 特权来源',
      };
    }
  }
  return { state: { ...s, modules: ids, step: 'storage' }, problem: null };
}

/**
 * ③★ 模块配置（#307）：保存一个选中模块的**非 secret** 配置值。
 * secret 字段整体跳过——值由服务层收进进程内存（不进 state，同 #272 token 语义），
 * 必填校验也在服务层（纯函数看不见 secret，不假装校验）。
 * 校验两道：模块在 moduleConfigs 里（没声明的模块不给存）；非 secret 必填缺失/空串即拒。
 * 声明之外的键一律丢弃（防注入面：页面多传的键不进状态）。返回新状态，原状态不动。
 */
export function saveConfigValues(
  s: WizardState,
  moduleId: string,
  values: Record<string, string>,
): { state: WizardState; problem: string | null } {
  const cfg = s.moduleConfigs.find((m) => m.id === moduleId);
  if (!cfg) return { state: s, problem: `模块 ${moduleId} 没有 config 声明：无配置页（③★ 只收声明过的模块）` };
  // 每次提交对该模块非 secret 值全量生效（页面一次收齐全部字段）；空串不落——
  // 缺省值在部署收集时（collectConfigValues）由 manifest default 兑底，不被空串覆盖。
  const next: Record<string, string> = {};
  for (const f of cfg.fields) {
    if (f.type === 'secret') continue;
    const raw = (values[f.key] ?? '').trim();
    if (f.required && !raw) return { state: s, problem: `「${f.label}」为必填项` };
    if (raw) next[f.key] = raw;
  }
  // 声明之外的键一律丢弃（防注入面：页面多传的键不进状态）。
  for (const k of Object.keys(next)) {
    if (!cfg.fields.some((f) => f.key === k)) delete next[k];
  }
  return { state: { ...s, configValues: { ...s.configValues, [moduleId]: next } }, problem: null };
}

/**
 * ③★ 步进：全部已声明模块都保存过（有必填且全齐）→ 进 ③½（storage）；
 * 有模块还没收值 → problem（指出第一个未完成模块）。
 * 空 moduleConfigs（全部模块无 config 声明）= ③ 直接跳到 ③½，本函数不该被调。
 */
export function finishModuleConfig(s: WizardState): { state: WizardState; problem: string | null } {
  for (const cfg of s.moduleConfigs) {
    const got = s.configValues[cfg.id];
    if (!got) return { state: s, problem: `模块 ${cfg.id} 的配置还没填` };
    for (const f of cfg.fields) {
      if (f.type === 'secret') continue; // secret 由服务层校验（进程内存，状态机看不见）
      if (f.required && !(got[f.key] ?? '').trim()) {
        return { state: s, problem: `模块 ${cfg.id} 的「${f.label}」为必填项` };
      }
    }
  }
  // 已声明模块数 ≥ 0：全跳过（无声明）时语义上不会进入本步；有声明但全部值齐 → 进 ③½。
  return { state: { ...s, step: 'storage' }, problem: null };
}

/**
 * ③★ 部署时收齐全部配置值（secret 由服务层合并进来）：
 * 模块 id → { key: 值 }；缺省键填 manifest default（字符串形态）。
 * 由服务层在 deps.deploy 调用时组装（secret 值从内存注入），非 secret 从 state 取。
 */
export function collectConfigValues(s: WizardState): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const cfg of s.moduleConfigs) {
    const got = s.configValues[cfg.id] ?? {};
    const merged: Record<string, string> = {};
    for (const f of cfg.fields) {
      const raw = got[f.key] ?? f.default ?? '';
      merged[f.key] = raw;
    }
    out[cfg.id] = merged;
  }
  return out;
}

/**
 * ③½ 存储选择（#55）：逐模块从 accepts 里选；选了 accepts 之外 → 拒绝（不进 ④）。
 * 有模块选 shared → 必须勾知情同意；未声明 storage 的模块固定 core。
 */
export function chooseStorage(
  s: WizardState,
  choices: Record<string, string>,
  sharedConsent: boolean,
): { state: WizardState; problem: string | null } {
  const next: Record<string, StorageLevel> = {};
  const LEVELS: StorageLevel[] = ['core', 'shared', 'dedicated', 'external'];
  for (const opt of s.storageOptions) {
    const raw = choices[opt.id] ?? opt.preferred ?? 'core';
    if (!(LEVELS as string[]).includes(raw)) {
      return { state: s, problem: `模块 ${opt.id} 的存储选择「${raw}」不是四级词表之一（core/shared/dedicated/external）` };
    }
    const level = raw as StorageLevel;
    if (!opt.accepts.includes(level)) {
      return {
        state: s,
        problem: `模块 ${opt.id} 不支持「${level}」（声明仅支持 ${opt.accepts.join('/')}）——选了 accepts 之外的模式即拒绝安装（#55）`,
      };
    }
    next[opt.id] = level;
  }
  const needsConsent = Object.values(next).some((v) => v === 'shared');
  if (needsConsent && !sharedConsent) {
    return { state: s, problem: '有模块选择 shared（共享库建表）：请先勾选知情同意' };
  }
  return { state: { ...s, storageChoices: next, sharedConsent, step: 'ready' }, problem: null };
}

/** ④ 由状态构造装配输入（workers.dev = domain 空串；storage 沿用 r2 默认）。
 * 模块条目一律 `{id, source}`（官方模块写 npm 串——决策 #77 A 方案）。 */
export function buildConfigInput(s: WizardState): {
  domain: string;
  modules: Array<{ id: string; source: string }>;
  storage: { provider: 'r2'; bucket: string };
} {
  return { domain: s.domain, modules: deployModules(s), storage: { provider: 'r2', bucket: 'unself-storage' } };
}

/** ④ 部署开始：进 deploying，events 起新段。 */
export function beginDeploy(s: WizardState): WizardState {
  return { ...s, step: 'deploying', error: null, result: null };
}

/** ④ 成功收尾（⑤）：baseUrl + setup 深链。 */
export function completeDeploy(s: WizardState, result: WizardResult): WizardState {
  return { ...s, step: 'done', result };
}

/** ④ 失败（三要素落状态；⑥ 语义：可 reset 重跑）。 */
export function failDeploy(s: WizardState, err: WizardError): WizardState {
  return { ...s, step: 'failed', error: err };
}

/**
 * ⑥ 幂等重跑：清错误/结果/事件回 ①（token 需重填——明文本就不留存）。
 * ③ 添加的第三方模块（#269）与 ③★ 配置声明/非 secret 值（#307）随 storageOptions/resourceNames
 * 一起保留（重跑收敛同一终态：重填的只有 token 与 secret 值——两者都只在进程内存）。
 */
export function resetWizard(s: WizardState): WizardState {
  const fresh = initialWizardState(s.instancePath, {
    modules: s.modules,
    storageOptions: s.storageOptions,
    resourceNames: s.resourceNames,
    moduleAdds: s.moduleAdds,
  });
  return { ...fresh, moduleConfigs: s.moduleConfigs, configValues: s.configValues, step: 'auth' };
}

/**
 * ③ 添加一个来源模块（#269）：并入 modules / storageOptions / moduleAdds。
 * 重复 id → problem（不静默覆盖）。返回新状态，原状态不动。
 */
export function addModule(
  s: WizardState,
  add: WizardModuleAdd,
): { state: WizardState; problem: string | null } {
  if (s.moduleAdds.some((a) => a.id === add.id)) {
    return { state: s, problem: `模块 ${add.id} 已在本次装配清单里（要换来源请先刷新页面重来）` };
  }
  const storageOptions = s.storageOptions.some((o) => o.id === add.id)
    ? s.storageOptions
    : [
        ...s.storageOptions,
        {
          id: add.id,
          accepts: add.storageAccepts,
          ...(add.storagePreferred !== undefined ? { preferred: add.storagePreferred } : {}),
        },
      ];
  return {
    state: {
      ...s,
      modules: s.modules.includes(add.id) ? s.modules : [...s.modules, add.id],
      moduleAdds: [...s.moduleAdds, add],
      storageOptions,
    },
    problem: null,
  };
}

/**
 * ③ 确认后交给 ④ 的模块条目（#269/#77）：**一律对象形态**（官方模块写 npm 串，来源模块写原串）。
 * 只保留仍在 modules 里的条目。
 */
export function deployModules(s: WizardState): Array<{ id: string; source: string }> {
  return s.modules.map((id) => {
    const add = s.moduleAdds.find((a) => a.id === id);
    return add ? { id, source: add.source } : officialModuleEntry(id);
  });
}

/** 对外（GET /api/state）暴露的状态投影：永不携带 token 明文。 */
export function publicState(s: WizardState): Omit<WizardState, never> {
  return { ...s, events: s.events.map((e) => ({ ...e })) };
}
