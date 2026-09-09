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

/** 选中 R2：脚本负责建桶。 */
export const R2StorageSchema = z.object({
  provider: z.literal('r2'),
  /** 桶名；缺省 unself-storage。 */
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

export const UnselfConfigSchema = z.object({
  /** 实例对外域名（如 team.example.com）；空/省略 → workers.dev 临时域。 */
  domain: z.string().trim().default(''),
  /** 选中启用的模块 id；空数组 = 全停用（未列出的已存在模块 → 注册表 not_deployed、其 zone 路由删除）。 */
  modules: z.array(z.string().regex(/^[a-z][a-z0-9-]+$/)),
  storage: StorageSchema.default({ provider: 'r2', bucket: 'unself-storage' }),
});

export type UnselfConfig = z.infer<typeof UnselfConfigSchema>;
export type StorageConfig = z.infer<typeof StorageSchema>;

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

/** 解析并校验配置文本。抛 ZodError/JSON 语法错误（调用方转人话）。 */
export function parseUnselfConfigText(text: string): UnselfConfig {
  const json = stripJsonc(text);
  return UnselfConfigSchema.parse(JSON.parse(json));
}

/** 读仓库根 unself.config.jsonc。 */
export async function loadUnselfConfig(rootDir: string): Promise<UnselfConfig> {
  const text = await readFile(`${rootDir}/unself.config.jsonc`, 'utf8');
  return parseUnselfConfigText(text);
}

/**
 * 模块发现类型（扫描在 main.ts）：扫描 modules 目录下各 manifest.yaml（最小 YAML 顶层键读取，只取 id 行）。
 * 未被 config.modules 选中的目录 → notDeployed（⑤ 注册表翻转 enabled=0）。
 */
export interface ModuleRef {
  /** 模块 id（manifest.yaml 的 id 行；与目录名一致约束由注册表校验兜底）。 */
  id: string;
  /** 模块包目录绝对路径。 */
  dir: string;
  /** 是否被本次配置选中（enabled）。 */
  selected: boolean;
}

/** 从 manifest.yaml 文本取顶层 `id:` 值（最小实现，不需要完整 YAML 解析）。 */
export function manifestId(manifestText: string): string | null {
  const m = /^id:\s*(\S+)\s*$/m.exec(manifestText);
  return m ? (m[1] ?? null) : null;
}
