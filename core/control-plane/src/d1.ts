// SPDX-License-Identifier: AGPL-3.0-only
/**
 * D1ControlPlane（core-api workers 运行时侧实现）：把 core-api 的 D1Database 绑到
 * 共用 SQL 上——core-api 的 upsertModule/consumeSetupToken 等语义与装配器完全同源（#64）。
 * 结构面取 D1Database 的最小子集（prepare/bind/first/all/run），不 import workers-types。
 */
import {
  REGISTRY_LIST_SQL,
  REGISTRY_TOGGLE_SQL,
  REGISTRY_UPSERT_SQL,
  SETUP_CONSUME_SQL,
  SETUP_INSERT_SQL,
  SETUP_RELEASE_SQL,
  SETUP_STATUS_SQL,
  SETUP_VALID_SQL,
} from './sql';
import { rowToEntry } from './sqlite';
import type { ControlPlane, ModuleRegistration, RegistryEntry, SetupTokenIssue } from './types';

/** D1 最小结构面（core-api env.CORE_DB 与本包 sqlite 执行器同形状）。 */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

interface RawRow {
  id: unknown;
  enabled: unknown;
  version: unknown;
  manifest_json: unknown;
}

export class D1ControlPlane implements ControlPlane {
  constructor(private readonly db: D1Like) {}

  async upsertModule(reg: ModuleRegistration): Promise<RegistryEntry> {
    const version = reg.version ?? readVersion(reg.manifest);
    const row = await this.db
      .prepare(REGISTRY_UPSERT_SQL)
      .bind(reg.id, reg.enabled ? 1 : 0, version, JSON.stringify(reg.manifest))
      .first<RawRow>();
    if (!row) throw new Error(`upsertModule 未返回行（id=${reg.id}）`);
    return rowToEntry({ ...row, manifest_json: row.manifest_json });
  }

  async toggleModule(id: string, enabled: boolean): Promise<RegistryEntry | null> {
    const row = await this.db.prepare(REGISTRY_TOGGLE_SQL).bind(id, enabled ? 1 : 0).first<RawRow>();
    return row ? rowToEntry({ ...row }) : null;
  }

  async readRegistry(): Promise<RegistryEntry[]> {
    const { results } = await this.db.prepare(REGISTRY_LIST_SQL).bind().all<RawRow>();
    return results.map((row) => rowToEntry({ ...row }));
  }

  async issueSetupToken(generate: () => string): Promise<SetupTokenIssue> {
    const row = await this.db.prepare(SETUP_STATUS_SQL).bind().first<Record<string, unknown>>();
    if (Number(row?.sealed ?? 0) > 0) return { status: 'sealed' };
    const existing = typeof row?.token === 'string' && row.token.length > 0 ? row.token : null;
    if (existing) return { status: 'reused', token: existing };
    const token = generate();
    await this.db.prepare(SETUP_INSERT_SQL).bind(token).run();
    return { status: 'created', token };
  }

  async isSetupTokenValid(token: string): Promise<boolean> {
    const row = await this.db.prepare(SETUP_VALID_SQL).bind(token).first();
    return row != null;
  }

  async consumeSetupToken(token: string, usedBy: string): Promise<boolean> {
    const { meta } = await this.db.prepare(SETUP_CONSUME_SQL).bind(token, usedBy).run();
    return meta.changes > 0;
  }

  async releaseSetupToken(token: string, usedBy: string): Promise<boolean> {
    const { meta } = await this.db.prepare(SETUP_RELEASE_SQL).bind(token, usedBy).run();
    return meta.changes > 0;
  }

  async applyMigrations(): Promise<never> {
    throw new Error('D1ControlPlane 不做迁移记账（迁移走装配器 REST import / wrangler 历史）；用 SqliteControlPlane');
  }

  async appliedMigrations(): Promise<never> {
    throw new Error('D1ControlPlane 不做迁移记账（迁移走装配器 REST import / wrangler 历史）；用 SqliteControlPlane');
  }

  async markMigrationApplied(): Promise<never> {
    throw new Error('D1ControlPlane 不做迁移记账（迁移走装配器 REST import / wrangler 历史）；用 SqliteControlPlane');
  }
}

function readVersion(manifest: unknown): string {
  if (manifest && typeof manifest === 'object' && 'version' in manifest) {
    const v = (manifest as Record<string, unknown>).version;
    if (typeof v === 'string' && v) return v;
  }
  return '0.0.0';
}
