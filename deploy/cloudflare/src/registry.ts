// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块注册表写入（步骤⑤，§5.5）：
 * 选中模块 upsert（enabled=1 + manifest 快照），未选/已存在模块翻转 enabled=0（not_deployed）。
 * 注册表 API（#7）持有管理员会话，装配期无会话 → 直写 module_registry（与 API 同构 upsert 语义）。
 */
import { ModuleManifestSchema, type ModuleManifest } from '@unself/contracts';
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
 * 最小 manifest.yaml 读取（§5.5 快照所需子集，不引入完整 YAML 解析）：
 * - 顶层标量 `key: value` 行（id/route/version/icon/description 等）；
 * - 缩进 list 项 `  - item`（requires/capabilities），归属最近一个「key: 空值」的顶层 key（行尾注释剥除）；
 * - flow 式 `key: [a, b]` 不支持——直接报错而非静默丢（#64：静默丢会致 token 授牌错误）。
 */
function manifestTopLevelFields(
  text: string,
): { scalars: Record<string, string>; lists: Record<string, string[]> } {
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let currentListKey: string | null = null;
  for (const line of text.split('\n')) {
    const scalar = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (scalar) {
      const value = scalar[2]!;
      if (value.startsWith('[')) {
        throw new Error(
          `manifest: 不支持 flow 式 list「${scalar[1]}: ${value}」——改用 block 式多行（SPEC §5.4，#64）`,
        );
      }
      if (value !== '') {
        scalars[scalar[1]!] = value;
        currentListKey = null;
      } else {
        // 顶层 key 空值 → 后续缩进 list 项归属该 key
        currentListKey = scalar[1]!;
      }
      continue;
    }
    const item = /^\s*-\s+(.+?)\s*(?:#.*)?$/.exec(line);
    if (item && currentListKey) {
      (lists[currentListKey] ??= []).push(item[1]!);
    }
  }
  return { scalars, lists };
}

/** manifest.yaml 文本 → ModuleManifest（§5.5 快照 + §5.3 entry 重写为实例 URL）。 */
export function buildManifestSnapshot(input: {
  manifestText: string;
  moduleId: string;
  /** 实例 base URL（https://domain 或 workers.dev）；空字符串 = workers.dev 占位。 */
  baseUrl: string;
}): ModuleManifest {
  const { scalars: fields, lists } = manifestTopLevelFields(input.manifestText);
  const host = input.baseUrl || 'https://unself-module-placeholder.workers.dev';
  const candidate = {
    id: fields.id ?? input.moduleId,
    route: fields.route ?? `/m/${input.moduleId}`,
    // 部署后模块实际从实例根相对路径装载（同域路径制 §5.3）
    entry: `${host}/m/${input.moduleId}/`,
    runtime: 'worker' as const,
    // 契约 requires min(1)：清单缺失时回退 identity；capabilities 缺失为空（不再硬编码 'demo'）
    requires: (lists.requires?.length ? lists.requires : ['identity']) as Array<'identity'>,
    capabilities: lists.capabilities ?? [],
    version: fields.version ?? '0.0.0',
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields.icon ? { icon: fields.icon } : {}),
  };
  return ModuleManifestSchema.parse(candidate);
}

/** SQL 字符串字面量（单引号翻倍）。 */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 选中模块的 upsert 语句参数（--json 命令数组形态）。 */
export function registryUpsertCommand(input: {
  manifest: ModuleManifest;
  dbPathHint?: never;
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
