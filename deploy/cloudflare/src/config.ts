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
 * 模块条目（决策 #77 A 方案）：**只收对象形态**（`{ id, source, storage? }`）。
 * 旧形态的裸字符串（`"hello"` = builtin 目录特例）已删除——官方模块也写 npm 串，与第三方同一个解析器。
 * 裸字符串会给人话迁移错（见 parseUnselfConfigText），不静默猜包名（猜包名 = 变相的官方特权）。
 */
export const ModuleEntrySchema = z.object({
  /** 实例内模块 id（决策 #59：全局唯一身份=包名/来源，id 只是实例内名字）。 */
  id: z.string().regex(/^[a-z][a-z0-9-]+$/),
  /** 来源：npm:/github:/https:/file:（docs/modules.md §1；四协议，无 official 协议）。 */
  source: z.string().min(1),
  /** 存储选择覆写（#55，来自向导③½/CLI --storage）：declaration ∈ manifest.storage.accepts。 */
  storage: z.object({ declaration: z.string().min(1) }).optional(),
});

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
  /** 选中启用的模块（`{id, source}`，官方模块也写 npm 串）；空数组 = 全停用（未列出的已存在模块 → 注册表 not_deployed、其 zone 路由删除）。 */
  modules: z.array(ModuleEntrySchema),
  storage: StorageSchema.default({ provider: 'r2', bucket: 'unself-storage' }),
});

export type UnselfConfig = z.infer<typeof UnselfConfigSchema>;
export type StorageConfig = z.infer<typeof StorageSchema>;

/** 归一化模块条目：统一为 {id, source}（source 必填——#77 起没有 builtin 缺省来源）。 */
export interface NormalizedModuleEntry {
  id: string;
  /** 来源字符串（npm:/github:/https:/file:）。 */
  source: string;
  /** 存储选择覆写（#55）：用户选定四级之一（向导③½ / CLI 覆写）；undefined = preferred ?? core。 */
  storage?: { declaration: string };
}

/** config.modules 归一化：对象条目 → 统一 {id, source, storage?}；同 id 重复条目拒绝。 */
export function normalizeModuleEntries(modules: UnselfConfig['modules']): NormalizedModuleEntry[] {
  const seen = new Set<string>();
  return modules.map((m) => {
    const entry: NormalizedModuleEntry = { id: m.id, source: m.source, ...(m.storage ? { storage: m.storage } : {}) };
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
  const raw = JSON.parse(json) as { modules?: unknown };
  // 裸字符串条目（旧 builtin 形态）给人话迁移错：zod 的报错看不出「该写什么」（#77 A 方案）
  if (Array.isArray(raw.modules)) {
    const bare = raw.modules.find((m) => typeof m === 'string');
    if (typeof bare === 'string') {
      throw new Error(
        `unself.config.jsonc 的模块条目 ${JSON.stringify(bare)} 是旧形态（裸字符串 = builtin 目录特例）：` +
          '决策 #77 起官方模块也走 npm 串、与第三方同一个解析器。请改写为对象形态，' +
          `例如 {"id":"hello","source":"npm:@unself/hello@0.1.0"}（官方模块的包名/版本见安装器预装的 @unself/hello / @unself/chat）`,
      );
    }
  }
  return withNamespacedBucket(UnselfConfigSchema.parse(raw));
}

/** 读仓库根 unself.config.jsonc。 */
export async function loadUnselfConfig(rootDir: string): Promise<UnselfConfig> {
  const text = await readFile(`${rootDir}/unself.config.jsonc`, 'utf8');
  return parseUnselfConfigText(text);
}

/**
 * 模块发现类型（扫描已删除：#77 起模块目录不再由引擎扫描）。
 * sourced（{id, source}）来自 config 条目，包根在来源解析后回填（dir/resolved 共用一份）。
 */
export interface ModuleRef {
  /** 模块 id（manifest 的 id；与 config 条目 id 的一致性由注册表/装配校验兜底）。 */
  id: string;
  /** 模块包目录绝对路径（取包前为空串，取包后回填）。 */
  dir: string;
  /** 是否被本次配置选中（enabled）——#77 起 = 是否在 config.modules 里。 */
  selected: boolean;
  /** 来源字符串（#245/#284）；条目必填，不再有 builtin 缺省。 */
  source?: string;
  /** 取包后的解析产物（步骤②½ 之后回填；步骤①/②/④/⑤ 共用 manifest/版本/落点）。 */
  resolved?: SourcedModule;
}

/** 从 manifest.yaml 文本取顶层 `id:` 值（最小实现，不需要完整 YAML 解析）。 */
export function manifestId(manifestText: string): string | null {
  const m = /^id:\s*(\S+)\s*$/m.exec(manifestText);
  return m ? (m[1] ?? null) : null;
}
