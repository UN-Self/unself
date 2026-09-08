// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

import { ModuleManifestSchema } from '@unself/contracts';

/**
 * 模块注册表（module_registry）API 契约：
 * deploy 脚本装配时写入（§5.5），运行时只翻转 enabled（启停秒级生效）。
 * manifest 存注册时的快照 JSON，运行期不回读模块源。
 */

/** 注册/更新请求体（deploy 脚本 → core-api）。 */
export const ModuleRegistrationSchema = z.object({
  /** 模块 id（表前缀/路由段/aud）。 */
  id: z.string().regex(/^[a-z][a-z0-9-]+$/),
  /** 是否启用（注册时默认按配置文件的选中状态）。 */
  enabled: z.boolean().default(true),
  /** 模块清单快照：注册时校验，运行期不回读。 */
  manifest: ModuleManifestSchema,
});

export type ModuleRegistration = z.infer<typeof ModuleRegistrationSchema>;

/** registry 行（API 响应形状；enabled 以 boolean 暴露，映射 D1 INTEGER 0/1）。 */
export interface RegistryEntry {
  id: string;
  enabled: boolean;
  version: string | null;
  manifest: unknown;
  /** 注册时间（ISO），审计用。 */
  registeredAt: string;
}

/** 启停响应。 */
export interface ToggleResult {
  id: string;
  enabled: boolean;
}

/** D1 行 → API 条目。 */
export function rowToEntry(row: { id: string; enabled: number; version: string | null; manifest_json: string; registered_at?: string }): RegistryEntry {
  let manifest: unknown;
  try {
    manifest = JSON.parse(row.manifest_json);
  } catch {
    manifest = null;
  }
  return {
    id: row.id,
    enabled: row.enabled === 1,
    version: row.version,
    manifest,
    registeredAt: row.registered_at ?? '',
  };
}

/** 注册或更新（upsert）：manifest 快照随注册刷新，enabled 按请求给。 */
export async function upsertModule(db: D1Database, reg: ModuleRegistration): Promise<RegistryEntry> {
  const manifestJson = JSON.stringify(reg.manifest);
  await db
    .prepare(
      `INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, version = excluded.version, manifest_json = excluded.manifest_json`,
    )
    .bind(reg.id, reg.enabled ? 1 : 0, reg.manifest.version, manifestJson)
    .run();
  return {
    id: reg.id,
    enabled: reg.enabled,
    version: reg.manifest.version,
    manifest: reg.manifest,
    registeredAt: new Date().toISOString(),
  };
}

/** 翻转启停（运行时秒级生效：边栏隐藏 + token 门禁拒发，§5.5）。 */
export async function toggleModule(db: D1Database, id: string, enabled: boolean): Promise<ToggleResult | null> {
  const row = await db
    .prepare('UPDATE module_registry SET enabled = ? WHERE id = ? RETURNING id, enabled')
    .bind(enabled ? 1 : 0, id)
    .first<{ id: string; enabled: number }>();
  if (!row) {
    return null;
  }
  return { id: row.id, enabled: row.enabled === 1 };
}

/** 列出全部模块（管理端；成员侧由 shell 过滤 enabled）。 */
export async function listModules(db: D1Database): Promise<RegistryEntry[]> {
  // 列集合与迁移 0001 建表严格一致（registered_at 列从未存在——旧实现线上 D1 报
  // no such column → /api/modules、/api/admin/modules 全 500；测试库 DDL 与迁移两张皮掩盖了它）
  const result = await db
    .prepare('SELECT id, enabled, version, manifest_json FROM module_registry ORDER BY id')
    .all<{ id: string; enabled: number; version: string | null; manifest_json: string }>();
  return result.results.map(rowToEntry);
}
