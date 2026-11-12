// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块注册表写入（步骤⑤，§5.5）：
 * 选中模块 upsert（enabled=1 + manifest 快照），未选/已存在模块翻转 enabled=0（not_deployed）。
 * 注册表 API（#7）持有管理员会话，装配期无会话 → 直写 module_registry（与 API 同构 upsert 语义）。
 */
import { ModuleManifestSchema, manifestFromYamlText, type ModuleManifest } from '@unself/contracts';
import type { UnselfConfig, ModuleRef } from './config';

/** 注册表 upsert SQL（与 core-api/control-plane REGISTRY_UPSERT_SQL 同源；0012 起带落点三列，
 * 0013 起带 credential_hash（#349，8 参形态）；合并语义同源——未写保留旧值，#348 review 定案。
 * installer 不传凭证（binds 恒 NULL = 首插落 NULL / 冲突保留旧值）：反连凭证只经
 * workbench connect-register / 保存流程写入，装配合不冲掉哈希。） */
export function registryUpsertSql(): string {
  return `INSERT INTO module_registry (id, enabled, version, manifest_json, mode, entry, storage_level, credential_hash)
VALUES (?1, ?2, ?3, ?4, coalesce(?5, 'cloudflare'), ?6, ?7, ?8)
ON CONFLICT(id) DO UPDATE SET
  enabled = excluded.enabled,
  version = excluded.version,
  manifest_json = excluded.manifest_json,
  mode = coalesce(?5, mode),
  entry = coalesce(?6, CASE WHEN coalesce(?5, mode) = 'connect' THEN entry END),
  storage_level = coalesce(?7, storage_level),
  credential_hash = coalesce(?8, credential_hash)`;
}

/**
 * manifest.yaml 文本 → ModuleManifest（§5.5 快照；#349 U9 起清单不含地址）。
 *
 * #243：YAML 解析与字段映射收口到 @unself/contracts（manifestFromYamlText），
 * 与 validate / 第三方 file: 安装共用同一份（防解析分叉致校验/授牌错位）。
 * 未知能力词在 schema 层直接抛错（安装时拒绝，不静默忽略）。
 * 地址不再进快照（U9）：模块可达 URL 走注册表 entry 列（upsertModule 的 entry 参数）。
 */
export function buildManifestSnapshot(input: {
  manifestText: string;
  moduleId: string;
  /** 已解析的 manifest（sourced 模块，#245）；缺省 = 从 manifestText（YAML）解析。 */
  manifest?: ModuleManifest;
}): ModuleManifest {
  if (input.manifest) {
    return ModuleManifestSchema.parse({
      ...input.manifest,
      id: input.manifest.id ?? input.moduleId,
      route: input.manifest.route ?? `/m/${input.moduleId}`,
      version: input.manifest.version ?? '0.0.0',
    });
  }
  const candidate = manifestFromYamlText(input.manifestText) as Record<string, unknown>;
  return ModuleManifestSchema.parse({
    ...candidate,
    id: candidate.id ?? input.moduleId,
    route: candidate.route ?? `/m/${input.moduleId}`,
    version: candidate.version ?? '0.0.0',
  });
}

/** SQL 字符串字面量（单引号翻倍）。 */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 选中模块的 upsert 语句参数（--json 命令数组形态）；落点三列（#348）随命令给，未写归一 NULL = 保留旧值（#348 review 定案）。
 * credential_hash 恒 NULL（#349：installer 不经手凭证；首插落 NULL，冲突分支保留已有哈希）。 */
export function registryUpsertCommand(input: {
  manifest: ModuleManifest;
  mode?: 'cloudflare' | 'docker' | 'connect' | null;
  entry?: string | null;
  storage_level?: string | null;
}): { sql: string; binds: [string, number, string, string, string | null, string | null, string | null, string | null] } {
  const { manifest } = input;
  const manifestJson = JSON.stringify(manifest);
  return {
    sql: registryUpsertSql(),
    binds: [
      manifest.id,
      1,
      manifest.version,
      manifestJson,
      input.mode ?? null,
      input.entry ?? null,
      input.storage_level ?? null,
      null,
    ],
  };
}

/** 未选模块的停用语句（幂等：不存在则无操作，不凭空创建行）。 */
export function registryDisableCommand(moduleId: string): string {
  return `UPDATE module_registry SET enabled = 0 WHERE id = ${sqlString(moduleId)}`;
}

/**
 * 注册表删行（#270 卸载：行没了 = token 门禁 404 = 该模块 token 失效）。
 * 参数化（?1）避免把 id 内联进 SQL；与 upsert/toggle 同一张表、同一套注册表语义。
 */
export function registryDeleteSql(): string {
  return 'DELETE FROM module_registry WHERE id = ?1';
}

/**
 * 步骤⑤全量语句：选中 upsert（enabled=1）+ 未选 disable（enabled=0）。
 * 顺序确定，重跑收敛到同一终态。
 */
export function registryCommands(input: {
  config: UnselfConfig;
  modules: ModuleRef[];
  baseUrl: string;
  manifestTexts: Record<string, string>;
}): Array<{ kind: 'upsert' | 'disable'; description: string; sql: string; binds?: unknown[] }> {
  const commands: Array<{ kind: 'upsert' | 'disable'; description: string; sql: string; binds?: unknown[] }> = [];
  for (const mod of input.modules) {
    if (!mod.selected) continue;
    const manifest = buildManifestSnapshot({
      manifestText: input.manifestTexts[mod.id] ?? '',
      moduleId: mod.id,
    });
    // #349 U9：地址写注册表 entry 列（真值面），快照不再携带 entry。
    const cmd = registryUpsertCommand({ manifest, entry: `${input.baseUrl}/m/${mod.id}/` });
    commands.push({ kind: 'upsert', description: `upsert ${mod.id}（enabled=1，快照刷新）`, ...cmd });
  }
  for (const mod of input.modules) {
    if (mod.selected) continue;
    commands.push({
      kind: 'disable',
      description: `disable ${mod.id}（not_deployed）`,
      sql: registryDisableCommand(mod.id),
    });
  }
  return commands;
}
