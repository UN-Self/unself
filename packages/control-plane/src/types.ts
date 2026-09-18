// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ControlPlane 公共类型（#64 决策）：
 * core-api（workers 运行时，d1 绑定）与装配器（CF REST / Docker node:sqlite）
 * 共用的最小结构面——SQL 在 sql.ts 单点定义，两个实现各自绑执行器，防漂移。
 */

/**
 * 控制面数据库执行器：core-api 传 D1Database（结构兼容子集），
 * sqlite 侧由本包的 SqliteExecutor 提供同形状。
 */
export interface ControlPlaneExecutor {
  prepare(sql: string): BoundQuery;
}

/** 绑定参数后的查询（first/all/run 与 D1 语义一致；bind 链式）。 */
export interface BoundQuery {
  bind(...values: unknown[]): {
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    run(): Promise<{ meta: { changes: number } }>;
  };
}

/** 注册表行（module_registry；enabled 以 0/1 存，接口层转 boolean）。 */
export interface RegistryEntry {
  id: string;
  enabled: boolean;
  version: string | null;
  manifest: unknown;
}

/** 注册/更新输入（装配器传完整快照；core-api 路由层已有 zod 门禁）。 */
export interface ModuleRegistration {
  id: string;
  enabled: boolean;
  manifest: unknown;
  /** manifest.version 镜像列（upsert 时随快照刷新）。 */
  version?: string;
}

/** setup token 三态（与 core-api setup 域语义对齐）。 */
export type SetupTokenIssue =
  | { status: 'sealed' }
  | { status: 'reused'; token: string }
  | { status: 'created'; token: string };

/** 控制面接口（#64）：注册表 / setup token / 迁移记账。 */
export interface ControlPlane {
  /** 注册或更新模块（manifest 快照随注册刷新，enabled 按请求给）。 */
  upsertModule(reg: ModuleRegistration): Promise<RegistryEntry>;
  /** 翻转启停（不存在的 id → null，不凭空建行）。 */
  toggleModule(id: string, enabled: boolean): Promise<RegistryEntry | null>;
  /** 列出全部模块（管理面）。 */
  readRegistry(): Promise<RegistryEntry[]>;
  /** 查封箱 + 复用未消费 token（重跑幂等）；已封箱 → sealed，绝不签发。 */
  issueSetupToken(generate: () => string): Promise<SetupTokenIssue>;
  /** 只验不消费（setup 向导可重复提交）。 */
  isSetupTokenValid(token: string): Promise<boolean>;
  /** 一次性消费（原子：UPDATE ... WHERE used_at IS NULL）。 */
  consumeSetupToken(token: string, usedBy: string): Promise<boolean>;
  /** 按模块独立记账表应用迁移文件（#55 记账隔离）；files 有序（文件名升序）。 */
  applyMigrations(module: string, files: Array<{ name: string; sql: string }>): Promise<ApplyReport>;
  /** 查某模块已应用的迁移名（升级预检/幂等对照用）。 */
  appliedMigrations(module: string): Promise<string[]>;
  /**
   * 记一条「已应用」事件（不执行 SQL）：DO 迁移 tag 等非 SQL 迁移与文件记账
   * **同一张** `unself_migrations_<module>` 表（#255/#55：不另造第二套记账）。
   * 由调用方在外部动作确认成功后调用；重复调用幂等（同 name 只留一行）。
   */
  markMigrationApplied(module: string, name: string): Promise<void>;
}

export interface ApplyReport {
  /** 本次真正执行的文件（按文件名记账跳过的不在内）。 */
  applied: string[];
  /** 记账表里已有、本次跳过的文件。 */
  skipped: string[];
}

/** 迁移记账表名前缀：`unself_migrations_<module>`（#55 护栏①：模块独立记账）。 */
export function migrationsTableFor(module: string): string {
  if (!/^[a-z][a-z0-9-]+$/.test(module)) {
    throw new Error(`模块 id 非法（需 ^[a-z][a-z0-9-]+$）："${module}"`);
  }
  return `unself_migrations_${module.replaceAll('-', '_')}`;
}
