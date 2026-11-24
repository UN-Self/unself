// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块注册表写入（步骤⑤，§5.5）：
 * 选中模块 upsert（enabled=1 + manifest 快照），未选/已存在模块翻转 enabled=0（not_deployed）。
 * 注册表 API（#7）持有管理员会话，装配期无会话 → 直写 module_registry（与 API 同构 upsert 语义）。
 */
import { ModuleManifestSchema, manifestFromYamlText, type ModuleManifest } from '@unself/contracts';
import { REGISTRY_UPSERT_WRITE_SQL } from '@unself/control-plane/sql';
import type { DeployMode } from '@unself/control-plane/types';
import type { UnselfConfig, ModuleRef } from './config';

/**
 * 注册表 upsert 写语句（8 参形态：0012 起带落点三列，0013 起带 credential_hash（#349），
 * 0017 起 mode 首插缺省 'direct'（#369 两态））。合并语义见 control-plane sql.ts：
 * 未写（绑定 NULL）保留列中旧值，#348 review 定案。installer 不传凭证（binds 恒 NULL =
 * 首插落 NULL / 冲突保留旧值）：反连凭证只经 workbench connect-register / 保存流程写入，
 * 装配不冲掉哈希。
 *
 * 以前这里自带一份「与 core 逐字同构」的副本、靠注释提醒同步（唯一差异是 core 那份多一条
 * RETURNING）。现在 control-plane 把写语句本体单独导出，四个控制面实现用的 = 本体 + RETURNING，
 * 装配器直接用本体——结构上不可能漂移，不再有第二份 SQL。
 */
export function registryUpsertSql(): string {
  return REGISTRY_UPSERT_WRITE_SQL;
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
  /** 接入方式（#369 两态 direct/connect）；缺省 NULL = 保留旧值，首插由 SQL 的 coalesce 落 'direct'。 */
  mode?: DeployMode | null;
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
