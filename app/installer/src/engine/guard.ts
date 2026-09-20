// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 撞车守卫（#272）：账户里已有同名资源、但**不属于本次实例**时，停住并说清，
 * 要显式开关（`--allow-adopt` / `UNSELF_ALLOW_ADOPT=1` / 向导④「允许接管」）才继续。禁止静默覆盖。
 *
 * 为什么需要：默认资源名曾是常量（`unself-core` / `unself-core-api` / `unself-storage`），
 * 同一 CF 账户上装第二个实例会静默复用第一个的 D1、覆盖其 Worker。命名空间化（#272 A）之后
 * 新实例落在独立命名空间；本守卫兜住「账户里已有同名资源」的残余面。
 *
 * 归属判定（「怎么知道某资源属不属于本实例」）：
 * - 本实例上次装配成功时把占用资源写进 `unself.lock.resources`（名 + id 台账）；
 * - 账户里存在的每个目标名都能在台账里对上（D1/KV 比 id，R2/Worker 比名）→ 属于本实例 → 放行（幂等重跑）；
 * - 台账缺失（#272 之前部署的老实例 / 全新实例目录）或对不上 → **无法证明归属** → 停住求助。
 *   这不是「无脑拦」：正常重跑（同一实例目录、台账在手）不被拦；只有证明不了归属才拦。
 */
import type { ResourceLedger } from './lock';
import { d1List, kvList, r2ListBuckets, getWorkerSettings } from './rest';
import type { RestClient } from './rest';

/** 资源种类（与 rest 层一一对应）。 */
export type ResourceKind = 'd1' | 'r2' | 'kv' | 'worker';

export interface TargetResource {
  kind: ResourceKind;
  name: string;
}

export interface ExistingResource extends TargetResource {
  /** D1 uuid / KV id（账户里查到的服务端 id；R2/Worker 无）。 */
  id?: string;
}

/** 资源种类的中文标签（人话报告用）。 */
const KIND_LABEL: Record<ResourceKind, string> = {
  d1: 'D1 数据库',
  r2: 'R2 桶',
  kv: 'KV 命名空间',
  worker: 'Worker 脚本',
};

/**
 * 本次装配会占用的资源名（纯函数；与 naming 同源）。
 * 只列「本次确实会创建/绑定」的名字，避免误报。
 */
export function targetResources(input: {
  /** 解析后的资源名前缀（`resourcePrefix()`：显式环境变量 > 命名空间 > ''）。 */
  prefix: string;
  /** 选中模块 id（module worker 名）。 */
  moduleIds: string[];
  /** R2 桶名；provider=s3（外部桶）时 undefined。 */
  bucket?: string;
  /** 落点 dedicated 的模块 id（专属 D1 `<ns>-<id>`）。 */
  dedicatedModuleIds?: string[];
  /** chat 选中时额外汇总 KV / R2 / 专属 D1。 */
  chatSelected?: boolean;
}): TargetResource[] {
  const p = input.prefix;
  const base = (name: string): string => (p ? `${p}${name}` : `unself-${name}`);
  const out: TargetResource[] = [
    { kind: 'd1', name: base('core') },
    { kind: 'd1', name: base('modules') },
    { kind: 'worker', name: base('workbench') },
  ];
  for (const id of input.moduleIds) out.push({ kind: 'worker', name: base(`module-${id}`) });
  for (const id of input.dedicatedModuleIds ?? []) out.push({ kind: 'd1', name: base(id) });
  if (input.bucket !== undefined) out.push({ kind: 'r2', name: input.bucket });
  if (input.chatSelected) {
    out.push({ kind: 'kv', name: base('chat-sessions') });
    out.push({ kind: 'r2', name: base('chat-files') });
  }
  // 去重（chat 的专属 D1 可能同时来自 dedicatedModuleIds）
  const seen = new Set<string>();
  return out.filter((t) => {
    const key = `${t.kind}:${t.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 台账是否覆盖某个已存在资源（归属证明）。D1/KV 比 id（有则必须一致），R2/Worker 比名。 */
export function ledgerCovers(ledger: ResourceLedger | undefined, existing: ExistingResource): boolean {
  if (!ledger) return false;
  if (existing.kind === 'd1') {
    return ledger.d1.some((r) => r.name === existing.name && (existing.id === undefined || r.id === existing.id));
  }
  if (existing.kind === 'kv') {
    return ledger.kv.some((r) => r.name === existing.name && (existing.id === undefined || r.id === existing.id));
  }
  if (existing.kind === 'r2') {
    return ledger.r2.some((r) => r.name === existing.name);
  }
  return ledger.workers.some((r) => r.name === existing.name);
}

/** Worker 是否存在（settings 404 = 不存在；与 hasWorkerSecret 同款探测）。 */
async function workerExists(client: RestClient, accountId: string, name: string): Promise<boolean> {
  try {
    await getWorkerSettings(client, accountId, name);
    return true;
  } catch {
    return false;
  }
}

/**
 * 查询账户里「与本次目标同名」的既有资源（只读；不创建任何东西）。
 * 只查本次目标涉及的种类（多数部署只有 d1/worker/r2）。
 */
export async function probeExisting(
  client: RestClient,
  accountId: string,
  targets: TargetResource[],
): Promise<ExistingResource[]> {
  const out: ExistingResource[] = [];
  const byKind = (kind: ResourceKind): TargetResource[] => targets.filter((t) => t.kind === kind);
  const d1Targets = byKind('d1');
  if (d1Targets.length > 0) {
    const list = await d1List(client, accountId);
    for (const t of d1Targets) {
      const found = list.find((d) => d.name === t.name);
      if (found) out.push({ ...t, id: found.uuid });
    }
  }
  const r2Targets = byKind('r2');
  if (r2Targets.length > 0) {
    const names = await r2ListBuckets(client, accountId);
    for (const t of r2Targets) {
      if (names.includes(t.name)) out.push({ ...t });
    }
  }
  const kvTargets = byKind('kv');
  if (kvTargets.length > 0) {
    const list = await kvList(client, accountId);
    for (const t of kvTargets) {
      const found = list.find((n) => n.title === t.name);
      if (found) out.push({ ...t, id: found.id });
    }
  }
  for (const t of byKind('worker')) {
    if (await workerExists(client, accountId, t.name)) out.push({ ...t });
  }
  return out;
}

/** 撞车守卫停住时抛的错误（人话 + 逐条资源清单 + 继续方式）。 */
export class ResourceCollisionError extends Error {
  constructor(
    readonly existing: ExistingResource[],
    readonly allowHint: string,
  ) {
    super(formatCollisionMessage(existing, allowHint));
    this.name = 'ResourceCollisionError';
  }
}

/** 停住原文（报告/向导三要素都直接展示）。 */
export function formatCollisionMessage(existing: ExistingResource[], allowHint: string): string {
  const lines = existing.map((e) => {
    const id = e.id ? `（${e.id}）` : '';
    return `  - ${KIND_LABEL[e.kind]}：${e.name}${id}`;
  });
  return [
    '撞车守卫：本实例要用的资源名在本账户已存在，且无法证明属于本实例（unself.lock 无对应资源台账）。',
    '为防静默复用别的实例的 D1 / 覆盖其 Worker，已停住（未创建、未修改任何资源）。',
    '将涉及以下既有资源：',
    ...lines,
    `若确认这些资源就是本实例的（或你确定要接管），重跑时加显式开关：${allowHint}。`,
    '（既有实例正常重跑不会被拦：上次装配成功会把资源台账写进 unself.lock，守卫据此放行。）',
  ].join('\n');
}

export interface GuardOutcome {
  /** clear=无同名资源；owned=台账对上（本实例幂等重跑）；adopted=显式开关放行。 */
  status: 'clear' | 'owned' | 'adopted';
  existing: ExistingResource[];
  /** 需要接管/对不上的资源（status=adopted 时 = 本次被显式接管的既有资源）。 */
  foreign: ExistingResource[];
}

/**
 * 归属判定（纯逻辑，不碰网络；便于单测与红灯变异）。
 * - 无同名资源 → clear；
 * - 全部同名资源都能被台账覆盖 → owned；
 * - 有对不上的 → allowAdopt ? adopted : 抛 ResourceCollisionError。
 */
export function decideGuard(input: {
  existing: ExistingResource[];
  ledger?: ResourceLedger;
  allowAdopt: boolean;
  /** 继续方式提示（CLI 与向导文案不同，由调用方给）。 */
  allowHint?: string;
}): GuardOutcome {
  if (input.existing.length === 0) {
    return { status: 'clear', existing: [], foreign: [] };
  }
  const foreign = input.existing.filter((e) => !ledgerCovers(input.ledger, e));
  if (foreign.length === 0) {
    return { status: 'owned', existing: input.existing, foreign: [] };
  }
  if (input.allowAdopt) {
    return { status: 'adopted', existing: input.existing, foreign };
  }
  throw new ResourceCollisionError(
    foreign,
    input.allowHint ?? '`--allow-adopt`（或 `UNSELF_ALLOW_ADOPT=1`）',
  );
}
