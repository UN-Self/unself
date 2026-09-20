// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RestD1ControlPlane（#64 CF 侧实现）：装配器经 CF REST（/d1/database/{id}/query）
 * 跑与 core-api / sqlite 完全同一份 SQL（sql.ts）——三实现防漂移。
 * 执行器只要求 query（参数绑定）+ importSql（整份 SQL 文件，服务端语句拆分）两个操作。
 */
import {
  migrationsCreateSql,
  migrationsInsertIgnoreSql,
  migrationsInsertSql,
  migrationsListSql,
  REGISTRY_LIST_SQL,
  REGISTRY_TOGGLE_SQL,
  REGISTRY_UPSERT_SQL,
  SETUP_CONSUME_SQL,
  SETUP_INSERT_SQL,
  SETUP_RELEASE_SQL,
  SETUP_STATUS_SQL,
  SETUP_VALID_SQL,
} from './sql';
import { migrationsTableFor } from './types';
import type { ApplyReport, ControlPlane, ModuleRegistration, RegistryEntry, SetupTokenIssue } from './types';

/** REST 侧 D1 执行器（装配引擎 src/engine 的 d1Query / d1Import 绑进来）。 */
export interface RestD1Executor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ results: T[]; meta: { changes: number } }>;
  importSql(sqlText: string): Promise<{ numQueries: number }>;
}

interface RawRow {
  id: unknown;
  enabled: unknown;
  version: unknown;
  manifest_json: unknown;
}

export class RestD1ControlPlane implements ControlPlane {
  constructor(private readonly exec: RestD1Executor) {}

  async upsertModule(reg: ModuleRegistration): Promise<RegistryEntry> {
    const version = reg.version ?? readVersion(reg.manifest);
    const { results } = await this.exec.query<RawRow>(
      REGISTRY_UPSERT_SQL,
      [reg.id, reg.enabled ? 1 : 0, version, JSON.stringify(reg.manifest)],
    );
    const row = results[0];
    if (!row) throw new Error(`upsertModule 未返回行（id=${reg.id}）`);
    return toEntry(row);
  }

  async toggleModule(id: string, enabled: boolean): Promise<RegistryEntry | null> {
    const { results } = await this.exec.query<RawRow>(REGISTRY_TOGGLE_SQL, [id, enabled ? 1 : 0]);
    const row = results[0];
    return row ? toEntry(row) : null;
  }

  async readRegistry(): Promise<RegistryEntry[]> {
    const { results } = await this.exec.query<RawRow>(REGISTRY_LIST_SQL);
    return results.map(toEntry);
  }

  async issueSetupToken(generate: () => string): Promise<SetupTokenIssue> {
    const { results } = await this.exec.query<{ sealed: unknown; token: unknown }>(SETUP_STATUS_SQL);
    const row: { sealed: unknown; token: unknown } = results[0] ?? { sealed: 0, token: null };
    if (Number(row.sealed ?? 0) > 0) return { status: 'sealed' };
    const existing = typeof row.token === 'string' && row.token.length > 0 ? row.token : null;
    if (existing) return { status: 'reused', token: existing };
    const token = generate();
    await this.exec.query(SETUP_INSERT_SQL, [token]);
    return { status: 'created', token };
  }

  async isSetupTokenValid(token: string): Promise<boolean> {
    const { results } = await this.exec.query(SETUP_VALID_SQL, [token]);
    return results.length > 0;
  }

  async consumeSetupToken(token: string, usedBy: string): Promise<boolean> {
    const { meta } = await this.exec.query(SETUP_CONSUME_SQL, [token, usedBy]);
    return meta.changes > 0;
  }

  async releaseSetupToken(token: string, usedBy: string): Promise<boolean> {
    const { meta } = await this.exec.query(SETUP_RELEASE_SQL, [token, usedBy]);
    return meta.changes > 0;
  }

  /**
   * 按模块独立记账（#55 护栏①）：记账表 DDL/INSERT 走 /query，
   * 迁移文件本体走 import（服务端整份执行，失败重跑整份重放）。
   * 老库对齐：若存在 wrangler 时代的 d1_migrations 表（同库），首次建记账表时
   * 按其已应用名单预置（同文件名视为已应用，升级链不重放老文件）。
   */
  async applyMigrations(module: string, files: Array<{ name: string; sql: string }>): Promise<ApplyReport> {
    const table = migrationsTableFor(module);
    const hasLedger = await tableExists(this.exec, table);
    if (!hasLedger) {
      await this.exec.query(migrationsCreateSql(module));
      await seedFromLegacyLedger(this.exec, module, table);
    }
    const applied = new Set(await this.appliedMigrations(module));
    const report: ApplyReport = { applied: [], skipped: [] };
    for (const file of files) {
      if (applied.has(file.name)) {
        report.skipped.push(file.name);
        continue;
      }
      await this.exec.importSql(file.sql);
      await this.exec.query(migrationsInsertSql(module), [file.name]);
      report.applied.push(file.name);
    }
    return report;
  }

  async appliedMigrations(module: string): Promise<string[]> {
    const table = migrationsTableFor(module);
    if (!(await tableExists(this.exec, table))) return [];
    const { results } = await this.exec.query<{ name: unknown }>(migrationsListSql(module));
    return results.map((r) => String(r.name));
  }

  async markMigrationApplied(module: string, name: string): Promise<void> {
    // 与 applyMigrations 同一张表（#255）：非 SQL 事件（DO 迁移 tag）走同一记账，幂等
    const table = migrationsTableFor(module);
    if (!(await tableExists(this.exec, table))) {
      await this.exec.query(migrationsCreateSql(module));
    }
    await this.exec.query(migrationsInsertIgnoreSql(module), [name]);
  }
}

async function tableExists(exec: RestD1Executor, table: string): Promise<boolean> {
  const { results } = await exec.query<{ n: unknown }>(
    'SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ?1 AND name = ?2',
    ['table', table],
  );
  return Number(results[0]?.n ?? 0) > 0;
}

/** 老库升级链对齐：wrangler d1_migrations（同库全局记账）已应用的文件名 → 预置进新记账表。 */
async function seedFromLegacyLedger(exec: RestD1Executor, module: string, table: string): Promise<void> {
  try {
    const { results } = await exec.query<{ name: unknown }>('SELECT name FROM d1_migrations ORDER BY name');
    for (const r of results) {
      await exec.query(`INSERT OR IGNORE INTO ${table} (name) VALUES (?1)`, [String(r.name)]);
    }
  } catch {
    // 无 d1_migrations（全新库）→ 无需对齐
  }
  void module;
}

function toEntry(row: RawRow): RegistryEntry {
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(String(row.manifest_json));
  } catch {
    manifest = null;
  }
  return {
    id: String(row.id),
    enabled: Number(row.enabled) === 1,
    version: row.version == null ? null : String(row.version),
    manifest,
  };
}

function readVersion(manifest: unknown): string {
  if (manifest && typeof manifest === 'object' && 'version' in manifest) {
    const v = (manifest as Record<string, unknown>).version;
    if (typeof v === 'string' && v) return v;
  }
  return '0.0.0';
}
