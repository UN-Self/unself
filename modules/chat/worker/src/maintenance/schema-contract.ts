// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/maintenance/schema-contract.ts（GPL-3.0-only，裁剪版）
// 部署工具与 Worker 共用采集、判定规则；这里不依赖 Node，也不执行修复或业务数据查询。
export const D1_MIGRATION_LEDGER = 'edgechat_schema_migrations';

type Row = Record<string, string | number | null>;
export type SchemaQuery = (sql: string) => Promise<Row[]>;
export interface SchemaManifest {
  version: string;
  schemaHash: string;
  artifacts: string[];
  migrations: { id: string; checksum: string; compatibleChecksums: string[] }[];
  retiredMigrations?: { id: string; checksum: string; compatibleChecksums: string[] }[];
}

export function schemaTables(manifest: SchemaManifest) {
  return manifest.artifacts.filter((artifact) => artifact.startsWith('table:')).map((artifact) => artifact.slice(6));
}

export async function collectSchemaArtifacts(query: SchemaQuery, tables?: string[]) {
  const objects = await query(
    "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'trigger', 'index') AND name NOT LIKE 'sqlite_%'"
  );
  const artifacts = new Set(objects.map((object) => `${object.type}:${object.name}`));
  const inspectedTables = tables ?? objects.filter((object) => object.type === 'table').map((object) => String(object.name));
  for (const table of inspectedTables) {
    // REST 与 binding 都支持表值 PRAGMA，避免 CI 与线上走不同查询。
    const columns = await query(`SELECT name FROM pragma_table_info('${table.replaceAll("'", "''")}')`);
    for (const column of columns) artifacts.add(`column:${table}.${column.name}`);
  }
  return artifacts;
}

export async function collectAppliedMigrations(query: SchemaQuery, artifacts: Set<string>) {
  if (!artifacts.has(`table:${D1_MIGRATION_LEDGER}`)) return new Map<string, string>();
  const rows = await query(`SELECT migration_id, checksum FROM ${D1_MIGRATION_LEDGER} ORDER BY migration_id`);
  return new Map(rows.map((row) => [String(row.migration_id), String(row.checksum)]));
}

export function assessSchema(manifest: SchemaManifest, artifacts: Set<string>, applied: Map<string, string>) {
  const missingArtifacts = manifest.artifacts.filter((artifact) => !artifacts.has(artifact));
  const missingMigrations = manifest.migrations.filter((migration) => !applied.has(migration.id)).map((migration) => migration.id);
  const recognizedMigrations = [...manifest.migrations, ...(manifest.retiredMigrations ?? [])];
  const changedMigrations = recognizedMigrations.filter((migration) => {
    const recorded = applied.get(migration.id);
    return recorded && recorded !== migration.checksum && !migration.compatibleChecksums.includes(recorded);
  }).map((migration) => migration.id);
  const knownIds = new Set(recognizedMigrations.map((migration) => migration.id));
  const unknownMigrations = [...applied.keys()].filter((id) => !knownIds.has(id)).sort();
  const ledgerPresent = artifacts.has(`table:${D1_MIGRATION_LEDGER}`);
  const status = changedMigrations.length ? 'checksum_mismatch'
    : unknownMigrations.length ? 'ahead'
    : missingArtifacts.length ? (missingMigrations.length ? 'missing_migrations' : 'drift')
    : !ledgerPresent || missingMigrations.length ? 'untracked' : 'ok';
  return {
    status, ledgerPresent, missingArtifacts, missingMigrations, changedMigrations, unknownMigrations,
    expectedMigration: manifest.migrations.at(-1)?.id ?? null,
    appliedMigration: [...applied.keys()].sort().at(-1) ?? null,
    appliedCount: manifest.migrations.length - missingMigrations.length,
    expectedCount: manifest.migrations.length,
    schemaHash: manifest.schemaHash
  };
}

export async function inspectSchema(query: SchemaQuery, manifest: SchemaManifest) {
  const artifacts = await collectSchemaArtifacts(query, schemaTables(manifest));
  const applied = await collectAppliedMigrations(query, artifacts);
  return assessSchema(manifest, artifacts, applied);
}
