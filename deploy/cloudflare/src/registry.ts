// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块注册表写入（步骤⑤，§5.5）：
 * 选中模块 upsert（enabled=1 + manifest 快照），未选/已存在模块翻转 enabled=0（not_deployed）。
 * 注册表 API（#7）持有管理员会话，装配期无会话 → 直写 module_registry（与 API 同构 upsert 语义）。
 */
import { ModuleManifestSchema, manifestFromYamlText, type ModuleManifest } from '@unself/contracts';
import type { UnselfConfig, ModuleRef } from './config';

/** 注册表 upsert SQL（与 core-api upsertModule 相同的收敛语义）。 */
export function registryUpsertSql(): string {
  return `INSERT INTO module_registry (id, enabled, version, manifest_json)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(id) DO UPDATE SET
  enabled = excluded.enabled,
  version = excluded.version,
  manifest_json = excluded.manifest_json`;
}

/**
 * manifest.yaml 文本 → ModuleManifest（§5.5 快照 + §5.3 entry 重写为实例 URL）。
 *
 * #243：YAML 解析与字段映射收口到 @unself/contracts（manifestFromYamlText），
 * 与 validate / 第三方 file: 安装共用同一份（防解析分叉致校验/授牌错位）。
 * 未知能力词在 schema 层直接抛错（安装时拒绝，不静默忽略）。
 */
export function buildManifestSnapshot(input: {
  manifestText: string;
  moduleId: string;
  /** 实例 base URL（https://domain 或 workers.dev）；空字符串 = workers.dev 占位。 */
  baseUrl: string;
  /**
   * 模块真实 entry（#273 按形态）：domain → `https://<domain>/m/<id>/`；
   * workers.dev → `https://<module-worker>.<sub>.workers.dev/`（模块自有子域）。
   * 缺省 = 回落旧的 `${baseUrl}/m/<id>/`（存量调用方/测试兼容）。
   */
  entry?: string;
  /** 已解析的 manifest（sourced 模块，#245）；缺省 = 从 manifestText（YAML）解析。 */
  manifest?: ModuleManifest;
}): ModuleManifest {
  const host = input.baseUrl || 'https://unself-module-placeholder.workers.dev';
  const entry = input.entry ?? `${host}/m/${input.moduleId}/`;
  if (input.manifest) {
    return ModuleManifestSchema.parse({
      ...input.manifest,
      id: input.manifest.id ?? input.moduleId,
      route: input.manifest.route ?? `/m/${input.moduleId}`,
      entry,
      version: input.manifest.version ?? '0.0.0',
    });
  }
  const candidate = manifestFromYamlText(input.manifestText) as Record<string, unknown>;
  return ModuleManifestSchema.parse({
    ...candidate,
    id: candidate.id ?? input.moduleId,
    route: candidate.route ?? `/m/${input.moduleId}`,
    // 部署后模块实际从实例根相对路径装载（同域路径制 §5.3）；workers.dev 形态为模块自有子域（#273）
    entry,
    version: candidate.version ?? '0.0.0',
  });
}

/** SQL 字符串字面量（单引号翻倍）。 */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 选中模块的 upsert 语句参数（--json 命令数组形态）。 */
export function registryUpsertCommand(input: {
  manifest: ModuleManifest;
}): { sql: string; binds: [string, number, string, string] } {
  const { manifest } = input;
  const manifestJson = JSON.stringify(manifest);
  return {
    sql: registryUpsertSql(),
    binds: [manifest.id, 1, manifest.version, manifestJson],
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
      baseUrl: input.baseUrl,
    });
    const cmd = registryUpsertCommand({ manifest });
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
