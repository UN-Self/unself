// SPDX-License-Identifier: AGPL-3.0-only
/**
 * unself.config.jsonc 解析（PRODUCT_SPEC §5.5）：
 * - 零依赖 JSONC 剥离（注释 + 尾逗号）→ JSON.parse → zod 校验；
 * - domain 空/省略 → null（脚本回退 workers.dev 临时域，#15 验收路径）；
 * - storage.provider = r2（脚本建桶）| s3（外部 S3/MinIO 参数，§5.5 ⑥）；
 * - modules 空数组合法 = 全停用（未列出的已存在模块 → 注册表 not_deployed、其 zone 路由删除）。
 */
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { SourcedModule } from './module-sources';
import { NAMESPACE_RE } from './naming';

/** 选中 R2：脚本负责建桶。 */
export const R2StorageSchema = z.object({
  provider: z.literal('r2'),
  /**
   * 桶名；缺省 = 与命名空间同源（`<namespace>-storage`；无 namespace 的历史实例 = `unself-storage`，#272）。
   * 显式写了非缺省值就照用（外部桶/自定义桶名）。
   */
  bucket: z.string().min(1).default('unself-storage'),
});
/** 外部 S3：部署者自备桶（MinIO/R2 外部/其他 S3 兼容）。 */
export const S3StorageSchema = z.object({
  provider: z.literal('s3'),
  endpoint: z.url(),
  bucket: z.string().min(1),
  region: z.string().min(1).default('auto'),
});
export const StorageSchema = z.discriminatedUnion('provider', [R2StorageSchema, S3StorageSchema]);

/**
 * 模块条目：字符串（builtin 目录形态，存量兼容）或对象（带 source 的第三方来源，#58）。
 * 对象只收 id+source；mode 等部署参数不在本 issue 范围（现有装配路径只有 worker 落点）。
 */
export const ModuleEntrySchema = z.union([
  z.string().regex(/^[a-z][a-z0-9-]+$/),
  z.object({
    /** 实例内模块 id（决策 #59：全局唯一身份=包名/来源，id 只是实例内名字）。 */
    id: z.string().regex(/^[a-z][a-z0-9-]+$/),
    /** 来源：official:/npm:/github:/https:/file:（docs/modules.md §1）。 */
    source: z.string().min(1),
    /** 存储选择覆写（#55，来自向导③½/CLI --storage）：declaration ∈ manifest.storage.accepts。 */
    storage: z.object({ declaration: z.string().min(1) }).optional(),
  }),
]);

export const UnselfConfigSchema = z.object({
  /** 实例对外域名（如 team.example.com）；空/省略 → workers.dev 临时域。 */
  domain: z.string().trim().default(''),
  /**
   * 实例命名空间（#272）：CF 资源名前缀（`mysite` → `mysite-core` / `mysite-core-api` / `mysite-storage`）。
   * **省略 = 历史形态 `unself-*`**——#272 之前部署的既有实例再次部署逐字不变（不会因为改名变孤儿）；
   * 新实例由 `init`/向导写入，从实例名派生。`UNSELF_RESOURCE_PREFIX` 仍可显式覆盖（探针/CI）。
   */
  namespace: z
    .string()
    .trim()
    .regex(NAMESPACE_RE, '命名空间只能小写字母/数字/连字符，首尾必须是字母或数字，长度 ≤40')
    .optional(),
  /** 选中启用的模块（字符串=builtin 目录；{id,source}=第三方来源）；空数组 = 全停用（未列出的已存在模块 → 注册表 not_deployed、其 zone 路由删除）。 */
  modules: z.array(ModuleEntrySchema),
  storage: StorageSchema.default({ provider: 'r2', bucket: 'unself-storage' }),
});

export type UnselfConfig = z.infer<typeof UnselfConfigSchema>;
export type StorageConfig = z.infer<typeof StorageSchema>;

/** 归一化模块条目：统一为 {id, source?}（source 缺省 = builtin modules/ 目录）。 */
export interface NormalizedModuleEntry {
  id: string;
  /** 来源字符串（official:/npm:/github:/https:/file:）；undefined = builtin。 */
  source?: string;
  /** 存储选择覆写（#55）：用户选定四级之一（向导③½ / CLI 覆写）；undefined = preferred ?? core。 */
  storage?: { declaration: string };
}

/** config.modules 归一化：字符串与对象两种形态 → 统一 {id, source?}；同 id 重复条目拒绝。 */
export function normalizeModuleEntries(modules: UnselfConfig['modules']): NormalizedModuleEntry[] {
  const seen = new Set<string>();
  return modules.map((m) => {
    const entry: NormalizedModuleEntry = typeof m === 'string'
      ? { id: m }
      : { id: m.id, source: m.source, ...(m.storage ? { storage: m.storage } : {}) };
    if (seen.has(entry.id)) {
      throw new Error(`unself.config.jsonc modules 出现重复模块 id："${entry.id}"（同 id 只允许一个条目）`);
    }
    seen.add(entry.id);
    return entry;
  });
}

/** 提取纯 id 列表（存量 discoverModules/交互确认等消费方不变）。 */
export function moduleIds(entries: NormalizedModuleEntry[]): string[] {
  return entries.map((e) => e.id);
}

/**
 * 剥离 JSONC 的注释与尾逗号（零依赖，字符串感知）。
 * 不支持转义引号外实体特例——配置文件场景足够（unself.config.jsonc 由人维护）。
 */
export function stripJsonc(source: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1] ?? '';
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next;
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  // 尾逗号：} 或 ] 前的逗号（跨空白）
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * R2 桶名与命名空间同源（#272）：配了命名空间但没显式写桶名（仍是历史缺省 `unself-storage`）时，
 * 桶名跟随命名空间 → `<namespace>-storage`。显式桶名（≠ 历史缺省）原样保留。
 */
export function withNamespacedBucket(cfg: UnselfConfig): UnselfConfig {
  if (
    cfg.namespace !== undefined &&
    cfg.storage.provider === 'r2' &&
    cfg.storage.bucket === 'unself-storage'
  ) {
    return { ...cfg, storage: { provider: 'r2', bucket: `${cfg.namespace}-storage` } };
  }
  return cfg;
}

/** 解析并校验配置文本。抛 ZodError/JSON 语法错误（调用方转人话）。 */
export function parseUnselfConfigText(text: string): UnselfConfig {
  const json = stripJsonc(text);
  return withNamespacedBucket(UnselfConfigSchema.parse(JSON.parse(json)));
}

/** 读仓库根 unself.config.jsonc。 */
export async function loadUnselfConfig(rootDir: string): Promise<UnselfConfig> {
  const text = await readFile(`${rootDir}/unself.config.jsonc`, 'utf8');
  return parseUnselfConfigText(text);
}

/**
 * 模块发现类型（扫描在 steps.discoverModules）：builtin 来自 modules 目录扫描；
 * sourced（{id, source}，#245）来自来源解析器取包后的包根。
 */
export interface ModuleRef {
  /** 模块 id（manifest.yaml 的 id 行；与目录名一致约束由注册表校验兜底）。 */
  id: string;
  /** 模块包目录绝对路径（sourced 条目在取包前为空串，取包后回填）。 */
  dir: string;
  /** 是否被本次配置选中（enabled）。 */
  selected: boolean;
  /** 来源字符串（#245）；undefined = builtin 目录模块。 */
  source?: string;
  /** 取包后的解析产物（sourced 条目；步骤②/④/⑤ 共用 manifest/版本/SRI）。 */
  resolved?: SourcedModule;
}

/** 从 manifest.yaml 文本取顶层 `id:` 值（最小实现，不需要完整 YAML 解析）。 */
export function manifestId(manifestText: string): string | null {
  const m = /^id:\s*(\S+)\s*$/m.exec(manifestText);
  return m ? (m[1] ?? null) : null;
}
