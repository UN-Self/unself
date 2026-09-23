// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 向导状态（服务端 /api/state 投影）的客户端视图类型与派生选择器。
 * 类型镜像 src/web/state.ts（服务端零依赖纯状态机）——SPA 只读投影，不镜像迁移逻辑。
 */
import type { WizardConfigField, WizardModuleConfig, WizardResourceName, WizardStorageOption } from './state-dto';

export type {
  WizardConfigField,
  WizardModuleConfig,
  WizardResourceName,
  WizardStorageOption,
} from './state-dto';

export type WizardStep =
  | 'auth'
  | 'domain'
  | 'modules'
  | 'module-config'
  | 'storage'
  | 'ready'
  | 'deploying'
  | 'done'
  | 'failed';

export interface WizardEvent {
  i: number
  kind: string
  n?: number
  title?: string
  text: string
}

export interface WizardError {
  cause: string
  owner: string
  fix: string
}

export interface WizardResult {
  baseUrl: string
  setupUrl: string | null
  /** 版本身份三项（#287，决策 #80）：完成屏展示，可整段复制（日志会被完成屏取代）。
   *  可缺省（旧快照/早期状态回放）：完成屏按空数组处理，不崩。 */
  identity?: string[]
}

export interface WizardEnvHint {
  hasEnvToken: boolean
  oauthUsable: boolean
  needsTotalTls: boolean
  ci: boolean
}

export interface WizardModuleAddDto {
  id: string
  source: string
  kind: string
  version: string
  integrity?: string
  permissions: string[]
  storageAccepts: WizardStorageOption['accepts']
  storagePreferred?: string
  configFields?: WizardConfigField[]
}

export interface WizardStateDto {
  step: WizardStep
  instancePath: string
  hasToken: boolean
  domainChoice: 'workers' | 'custom' | null
  domain: string
  modules: string[]
  storageOptions: WizardStorageOption[]
  moduleAdds: WizardModuleAddDto[]
  moduleConfigs: WizardModuleConfig[]
  configValues: Record<string, Record<string, string>>
  resourceNames: WizardResourceName[]
  storageChoices: Record<string, string>
  sharedConsent: boolean
  events: WizardEvent[]
  error: WizardError | null
  result: WizardResult | null
  hasEnv?: boolean
  envHint?: WizardEnvHint
  credentialSource?: 'oauth' | 'token' | null
  idempotent?: boolean
  idempotentNote?: string
}

/** 步进器条目与渲染序（与服务端 WIZARD_STEP_ORDER 语义一致；deploying/failed 归 ready）。 */
export const STEPS: Array<{ id: WizardStep; label: string }> = [
  { id: 'auth', label: '凭证' },
  { id: 'domain', label: '域名' },
  { id: 'modules', label: '模块' },
  { id: 'module-config', label: '配置' },
  { id: 'storage', label: '数据' },
  { id: 'ready', label: '装配' },
  { id: 'done', label: '完成' },
];

export function stepIndexOf(step: WizardStep): number {
  const norm: WizardStep = step === 'deploying' || step === 'failed' ? 'ready' : step;
  return Math.max(0, STEPS.findIndex((s) => s.id === norm));
}

/** ?step= 只回已完成步（渲染守卫在服务端；前端点击面同语义）。 */
export function canNavigateTo(current: WizardStep, target: WizardStep): boolean {
  return stepIndexOf(target) < stepIndexOf(current);
}

/** 上一步目标（当前步的前一个已完成步）；第一步 null。 */
export function previousStepOf(current: WizardStep): WizardStep | null {
  const idx = stepIndexOf(current);
  return idx <= 0 ? null : STEPS[idx - 1]!.id;
}
