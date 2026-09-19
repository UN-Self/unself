// SPDX-License-Identifier: AGPL-3.0-only
/**
 * unself.lock 读写与决策（docs/modules.md §8，决策 #60，issue #245）。
 *
 * lock 记录每个模块的：来源 source、确切版本 version、包 integrity（SRI sha512）、
 * manifestHash（manifest 规范化 JSON 的 sha256-hex）、安装时契约版本 contractVersion。
 * lock **不含用户配置**（那是 config 的职责）；builtin 模块也进 lock（决策 #60）。
 *
 * 三种决策（buildLockPlan）：
 * - reuse：config 与 lock 一致 → 用 lock，**不再解析来源**（重跑一律用 lock）；
 * - re-resolve：config 条目不在 lock（新装）→ 解析来源；
 * - drift / explicit-upgrade：config 版本段变了 → 重解析 + 打印 diff + 要确认（-y 跳过）；
 *   lock 里有而 config 没有 → removed；config 里有而 lock 没有 → added。
 *
 * 完整性（verifyLockIntegrity）：reused 模块包字节的 SRI 与 lock 记录比对，不匹配**直接拒绝**。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sriFromBuffer } from './sources';
import type { NormalizedModuleEntry } from './config';

// ---------------------------------------------------------------------------
// lock 文件模型
// ---------------------------------------------------------------------------

/** 单模块锁条目。 */
export const LockEntrySchema = z.object({
  /** 全局唯一身份 = 包名/来源（决策 #59）；官方模块也记 npm 串（#77，如 npm:@unself/hello@0.1.0）。 */
  source: z.string().min(1),
  /** 解析出的确切版本（semver x.y.z）。 */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** 包字节 SRI（sha512-<base64>）；本地目录形态（npm 本地命中 / file:）无 tarball → 缺省。 */
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/).optional(),
  /** manifest 规范化 JSON 的 sha256-hex（manifest 变了 = 内容变了，即使版本没变）。 */
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** 安装时的契约版本（决策 #57：core 升级时据此发现潜在破坏）。 */
  contractVersion: z.string().regex(/^\d+\.\d+$/),
});
export type LockEntry = z.infer<typeof LockEntrySchema>;

/** 单个已记账资源（D1/KV 带服务端 id；R2/Worker 只有名）。 */
export const ResourceLedgerSchema = z.object({
  /** 本实例命名空间（dev 探针/无命名空间历史实例省略）。 */
  namespace: z.string().optional(),
  d1: z.array(z.object({ name: z.string().min(1), id: z.string().min(1) })).default([]),
  kv: z.array(z.object({ name: z.string().min(1), id: z.string().min(1) })).default([]),
  r2: z.array(z.object({ name: z.string().min(1) })).default([]),
  workers: z.array(z.object({ name: z.string().min(1) })).default([]),
});
export type ResourceLedger = z.infer<typeof ResourceLedgerSchema>;

/** unself.lock 顶层模型。lockVersion 只在破坏性变更时 bump。 */
export const LockFileSchema = z.object({
  lockVersion: z.literal(1),
  /** 安装器生成的 UTC 时间（ISO）。 */
  generatedAt: z.string().min(1),
  /** 模块 id → 锁条目。 */
  modules: z.record(z.string(), LockEntrySchema),
  /**
   * CF 资源台账（#272）：装配成功时写入本实例占用的 D1/KV/R2/Worker「名 + id」。
   * 撞车守卫据此判定「账户里同名资源是否属于本实例」——台账对不上/不存在即停住求助，不静默接管。
   * 旧实例（#272 之前部署）没有本段 → 守卫按「无法证明归属」处理（要求显式 `--allow-adopt`）。
   */
  resources: ResourceLedgerSchema.optional(),
});
export type LockFile = z.infer<typeof LockFileSchema>;

/** lock 文件默认路径（实例根下）。 */
export const LOCK_FILENAME = 'unself.lock';

/** manifest 规范化哈希：JSON.stringify 稳定序（键排序）→ sha256-hex。 */
export function manifestHashOf(manifest: unknown): string {
  return createHash('sha256').update(stableStringify(manifest)).digest('hex');
}

/** 稳定序字符串化（键排序递归；数组保序）。实现小、无依赖；避免引入 json-stable-stringify。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** 空 lock（无模块）。 */
export function emptyLock(): LockFile {
  return { lockVersion: 1, generatedAt: new Date().toISOString(), modules: {} };
}

/** 序列化 lock 文本（JSON，2 空格；人可读可 diff，禁止注释——lock 由工具维护）。 */
export function serializeLock(lock: LockFile): string {
  return `${JSON.stringify(LockFileSchema.parse(lock), null, 2)}\n`;
}

/** 解析 lock 文本（坏结构人话报错；caller 决定坏 lock 是否可继续）。 */
export function parseLockText(text: string): LockFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`unself.lock 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = LockFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；');
    throw new Error(`unself.lock 结构非法（${detail}）——删除该文件重装，或修复后重跑`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// 计划构建：config × lock → reuse / added / changed / removed
// ---------------------------------------------------------------------------

/** 计划中单个模块的动作。 */
export type LockPlanAction = 'reuse' | 'added' | 'changed' | 'removed';

export interface LockPlanItem {
  id: string;
  action: LockPlanAction;
  /** 来源（config 的；removed 时取 lock 的旧值）。 */
  source?: string;
  /** lock 旧条目（reuse/changed/removed）。 */
  previous?: LockEntry;
}

export interface LockPlan {
  items: LockPlanItem[];
  /** 需要重解析来源的模块（added + changed）。 */
  resolve: LockPlanItem[];
  /** config 声明但需要复用 lock 的（reuse）。 */
  reuse: LockPlanItem[];
  /** config 删除的（lock 里有而 config 没有）。 */
  removed: LockPlanItem[];
}

/**
 * config × lock → 安装计划（纯函数）。
 *
 * 「changed」的定义：source 协议体变了，或 config 显式要求重装。
 * 版本不在 config 里表达（config 只有 source；npm source 的版本段算 source 一部分）。
 */
export function buildLockPlan(input: {
  entries: NormalizedModuleEntry[];
  lock: LockFile;
}): LockPlan {
  const items: LockPlanItem[] = [];
  const resolve: LockPlanItem[] = [];
  const reuse: LockPlanItem[] = [];
  const removed: LockPlanItem[] = [];
  const configIds = new Set(input.entries.map((e) => e.id));
  for (const entry of input.entries) {
    const effectiveSource = entry.source;
    const prev = input.lock.modules[entry.id];
    if (!prev) {
      const item: LockPlanItem = { id: entry.id, action: 'added', source: effectiveSource };
      items.push(item);
      resolve.push(item);
      continue;
    }
    if (prev.source === effectiveSource) {
      const item: LockPlanItem = { id: entry.id, action: 'reuse', source: effectiveSource, previous: prev };
      items.push(item);
      reuse.push(item);
    } else {
      // 来源变了 = 显式升级/换源 → 重解析
      const item: LockPlanItem = { id: entry.id, action: 'changed', source: effectiveSource, previous: prev };
      items.push(item);
      resolve.push(item);
    }
  }
  for (const [id, prev] of Object.entries(input.lock.modules)) {
    if (!configIds.has(id)) {
      removed.push({ id, action: 'removed', source: prev.source, previous: prev });
    }
  }
  return { items, resolve, reuse, removed };
}

/**
 * config 与 lock 的漂移 diff（人话，打印给部署者确认）。
 * 逐模块列动作与新旧来源/版本。
 */
export function formatLockDiff(plan: LockPlan): string[] {
  const lines: string[] = [];
  for (const item of plan.items) {
    if (item.action === 'reuse') continue;
    if (item.action === 'added') {
      lines.push(`+ ${item.id}（新增）← ${item.source}`);
    } else if (item.action === 'changed') {
      lines.push(`~ ${item.id}：${item.previous?.source ?? '(?)'} → ${item.source}`);
    }
  }
  for (const item of plan.removed) {
    lines.push(`- ${item.id}（config 已移除；lock 记录 ${item.previous?.version ?? '?'} @ ${item.source}）`);
  }
  return lines;
}

/** 漂移确认提示语（无漂移返回 null）。 */
export function driftNotice(plan: LockPlan): string | null {
  const driftCount = plan.items.filter((i) => i.action !== 'reuse').length + plan.removed.length;
  if (driftCount === 0) return null;
  return `unself.lock 与 unself.config.jsonc 不一致（${driftCount} 个模块）：重解析来源并更新 lock。`;
}

// ---------------------------------------------------------------------------
// 完整性验证（决策 #60：哈希不匹配直接拒绝）
// ---------------------------------------------------------------------------

export interface IntegrityFailure {
  id: string;
  kind: 'integrity' | 'manifestHash';
  expected: string;
  actual: string;
}

/**
 * 逐模块校验：包字节 SRI（有 integrity 记录的）与 manifestHash。
 * 任一不匹配 → failures 非空，调用方**必须拒绝安装**（不停在第一处，全部列出）。
 */
export function verifyLockIntegrity(input: {
  plan: LockPlan;
  /** 模块 id → 解包后包根的 manifest（已解析对象）。 */
  manifests: Record<string, unknown>;
  /** 模块 id → 包根全部文件的相对路径 → 字节（用于算包 SRI；builtin/file: 无则跳过 SRI 比对）。 */
  packageFiles?: Record<string, Record<string, Buffer>>;
  /** 模块 id → 本次下载得到的包 SRI（有下载场景优先用这个，免重读盘）。 */
  downloadedSris?: Record<string, string>;
}): IntegrityFailure[] {
  const failures: IntegrityFailure[] = [];
  for (const item of input.plan.reuse) {
    const prev = item.previous!;
    // manifest 哈希：无论有无 tarball 都比对（builtin 也有 manifest）
    const manifest = input.manifests[item.id];
    if (manifest === undefined) {
      failures.push({ id: item.id, kind: 'manifestHash', expected: prev.manifestHash, actual: '(manifest 缺失)' });
      continue;
    }
    const actualHash = manifestHashOf(manifest);
    if (actualHash !== prev.manifestHash) {
      failures.push({ id: item.id, kind: 'manifestHash', expected: prev.manifestHash, actual: actualHash });
    }
    // 包 SRI：优先用下载时算的
    const actualSri = input.downloadedSris?.[item.id] ?? (input.packageFiles?.[item.id]
      ? sriFromBuffer(concatSorted(input.packageFiles[item.id]!))
      : undefined);
    if (prev.integrity !== undefined && actualSri !== undefined && actualSri !== prev.integrity) {
      failures.push({ id: item.id, kind: 'integrity', expected: prev.integrity, actual: actualSri });
    }
  }
  return failures;
}

/** 稳定序拼接文件字节（路径排序，路径+内容进哈希）。 */
function concatSorted(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const name of Object.keys(files).sort()) {
    parts.push(Buffer.from(name, 'utf8'), Buffer.from([0]), files[name]!, Buffer.from([1]));
  }
  return Buffer.concat(parts);
}

/** 完整性失败的人话（拒绝安装时打印）。 */
export function formatIntegrityFailures(failures: IntegrityFailure[]): string[] {
  return failures.map((f) =>
    f.kind === 'integrity'
      ? `✗ ${f.id}：包 integrity 不匹配（lock 期望 ${f.expected.slice(0, 24)}…，实测 ${f.actual.slice(0, 24)}…）——tarball 可能被篡改，已拒绝安装`
      : `✗ ${f.id}：manifestHash 不匹配（lock 期望 ${f.expected.slice(0, 16)}…，实测 ${f.actual.slice(0, 16)}…）——包内容与锁定版本不一致，已拒绝安装`,
  );
}
