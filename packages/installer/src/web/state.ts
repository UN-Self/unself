// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web 向导状态机（#242/#70：六段流语义，载体 = 本地 Web 页）：
 * ① 认证（token 填密码框，形态校验，可重试）→ ② 域名（workers.dev 显式第一项 / 自有域体检）
 * → ③ 模块确认 → ④ 九步进度（事件流，失败三要素：原因/归属/修复）→ ⑤ 收尾下一步（setup 链接）
 * → ⑥ 幂等重跑（reset 回 ①，任何时候重跑收敛同一终态）。
 * 纯状态机：不碰 node:* 与网络；token 只记 hasToken，明文不进状态（页面/JSON 均不可回读）。
 */

/** 向导步骤（①→⑥ 对应 auth→…→done/failed，reset 回 auth）。 */
export type WizardStep = 'auth' | 'domain' | 'modules' | 'ready' | 'deploying' | 'done' | 'failed';

/** 失败三要素（语义同 deploy/cloudflare errors.advise）。 */
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

/** 部署结果（⑤ 收尾：baseUrl + setup 深链）。 */
export interface WizardResult {
  baseUrl: string;
  /** setup token 存在时给 /setup?token=… 深链；sealed（已有管理员）为 null。 */
  setupUrl: string | null;
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
  events: WizardEvent[];
  error: WizardError | null;
  result: WizardResult | null;
}

/** 初始状态（① auth）。instancePath 必填——页头常驻可见（决策 #53）。 */
export function initialWizardState(instancePath: string, options?: { modules?: string[] }): WizardState {
  return {
    step: 'auth',
    instancePath,
    hasToken: false,
    domainChoice: null,
    domain: '',
    modules: options?.modules ?? ['hello'],
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
 * token 形态校验（语义与 deploy/cloudflare interactive.tokenProblem 同源：#66/#249）。
 * 只拦「明显不对」，真伪以 CF 校验为准。返回 null = 合法。
 */
export function tokenProblem(token: string): string | null {
  const t = token.trim();
  if (!t) return 'token 为空';
  if (/\s/.test(t)) return 'token 里含空格/换行：可能是复制带了空白或粘了两段，请重新整段复制粘贴';
  if (!/^[A-Za-z0-9_-]+$/.test(t)) return 'token 含字母数字以外的字符：请确认复制的是 API Token 本身（不是邮箱/Notation/密钥 JSON）';
  if (!/^[A-Za-z]/.test(t)) return 'token 形态不像 CF API Token（应以字母开头的 40 位字母数字）：请确认复制完整';
  if (t.length < 30 || t.length > 50) return `token 长度 ${t.length} 不像 CF API Token（应为 40 位左右）：请确认复制完整`;
  return null;
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

/** ③ 模块确认：非空 id 清单（去空格去重）；空清单不合法（至少确认一次选择）。 */
export function confirmModules(s: WizardState, modules: string[]): { state: WizardState; problem: string | null } {
  const ids = [...new Set(modules.map((m) => m.trim()).filter((m) => m.length > 0))];
  if (ids.length === 0) return { state: s, problem: '至少确认一个模块（或回到配置文件改 modules）' };
  for (const id of ids) {
    if (!/^[a-z][a-z0-9-]+$/.test(id)) return { state: s, problem: `模块 id 不合法：${id}（小写字母开头，小写字母/数字/连字符）` };
  }
  return { state: { ...s, modules: ids, step: 'ready' }, problem: null };
}

/** ④ 由状态构造装配输入（workers.dev = domain 空串；storage 沿用 r2 默认）。 */
export function buildConfigInput(s: WizardState): { domain: string; modules: string[]; storage: { provider: 'r2'; bucket: string } } {
  return { domain: s.domain, modules: s.modules, storage: { provider: 'r2', bucket: 'unself-storage' } };
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

/** ⑥ 幂等重跑：清错误/结果/事件回 ①（token 需重填——明文本就不留存）。 */
export function resetWizard(s: WizardState): WizardState {
  return { ...initialWizardState(s.instancePath, { modules: s.modules }), step: 'auth' };
}

/** 对外（GET /api/state）暴露的状态投影：永不携带 token 明文。 */
export function publicState(s: WizardState): Omit<WizardState, never> {
  return { ...s, events: s.events.map((e) => ({ ...e })) };
}
