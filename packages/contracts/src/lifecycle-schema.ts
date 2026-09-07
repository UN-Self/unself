// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * 模块生命周期数据形状的机器校验契约（随 types/lifecycle.ts 走 §5.4）。
 * types 仅约束模块实现；schemas 供 Core 侧解析与备份工具校验导出包。
 */

/** 导出包内单张表的条目。 */
export const ExportTableSchema = z.object({
  /** 行 schema 版本（默认 1），随模块迁移演进。 */
  schemaVersion: z.number().int().min(1),
  /** 全量行数据；行形状归模块自己的 schema 管，契约不做二次校验。 */
  rows: z.array(z.unknown()),
});

/** 导出包内的存储对象引用。 */
export const ExportFileRefSchema = z.object({
  /** 存储层完整对象键（含模块前缀，如 `hello/xx.png`）。 */
  key: z.string().min(1),
  /** 字节大小；未知时省略。 */
  size: z.number().int().min(0).optional(),
  /** 可选 MIME 类型。 */
  contentType: z.string().optional(),
});

/** 模块全量导出包（§5.4）：JSON 表数据 + 文件引用，不含二进制内容。 */
export const ExportBundleSchema = z.object({
  /** 契约版本，当前恒为 1。 */
  version: z.literal(1),
  /** 导出模块 id（表前缀）。 */
  moduleId: z.string().regex(/^[a-z][a-z0-9-]+$/),
  /** 导出时间（ISO 8601 UTC）。 */
  exportedAt: z.iso.datetime(),
  /** 换出前表名 → 表数据。 */
  tables: z.record(z.string(), ExportTableSchema),
  /** 存储层对象引用（R2/S3 键，不含二进制内容）。 */
  files: z.array(ExportFileRefSchema),
});

export type ExportBundleParsed = z.infer<typeof ExportBundleSchema>;
