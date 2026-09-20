// SPDX-License-Identifier: AGPL-3.0-only

/**
 * chat 模块测试工厂：真 SQLite（node:sqlite，Node≥22 内置，零新依赖）
 * 加载 app/modules/chat/migrations/chat/0001_baseline.sql 真建表 + 最小 D1 适配器 + 内存 KV。
 *
 * 为什么自己 fork 而不 import module-sdk 的 test-factory：后者默认加载
 * app/modules/hello/migrations/hello/ 的 module_kv 迁移——chat 不用 module_kv，
 * chat 的 schema 真值唯一来源是上游 worker 的 schema-baseline.sql。
 *
 * 为什么不用手搓假 D1（docs/testing.md 禁项 / #60）：假替身按字符串匹配解释 SQL，
 * SQL 漏 WHERE、引用幻影列、语义写偏都能全绿；真 SQLite 加载真 schema 后，
 * 列错位/表缺失当场抛错。适配器对齐真 D1 语义（实现思路抄自本仓 AGPL 代码
 * core/sdk/test/test-factory.ts）：
 * - prepare(sql).bind(...).first()/all()/run() 链式；
 * - all() 回 { results, success, meta }，run() 回 meta.changes/last_row_id；
 * - first() 无行回 null，支持 first('col') 单列；行是普通对象（非 null 原型）；
 * - datetime('now') 文本语义由 SQLite 原生保证。
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { hashPassword } from '../worker/src/auth.js';

/** 测试固定密钥环（32 字节 base64，v1 单键）——env 形状与 .dev.vars 种子一致。 */
export const TEST_KEYRING = JSON.stringify({
  activeKeyId: 'v1',
  keys: { v1: 'WkRhyAiq6hu6J7wHEIvM+8fmRoL6rvhezCfM3Fga7M8=' },
});

/** node:sqlite 的 null 原型行 → 普通对象（与真 D1 返回形状一致）。 */
function plainRow<T>(row: Record<string, unknown>): T {
  return { ...row } as T;
}

/** D1 run/exec 的 meta 形状（workers-types D1Meta 的完整字段集）。 */
interface D1Meta {
  duration: number;
  size_after: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changed_db: boolean;
  changes: number;
}

/** D1 执行结果形状。 */
interface D1Result<T> {
  results: T[];
  success: boolean;
  meta: D1Meta & Record<string, unknown>;
}

function d1Meta(changes: number, lastRowId: number): D1Meta & Record<string, unknown> {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  };
}

/** 只读语句判定：真 D1 对 SELECT 的 run() 回 changes=0。 */
const READ_ONLY_SQL = /^\s*(select|with|pragma)\b/i;

/** 单条语句的 D1 适配（bind 后 first/all/run）。 */
class SqliteD1Statement {
  private params: unknown[] = [];

  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.params = values;
    return this;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.params);
    if (row === undefined) {
      return null;
    }
    if (colName !== undefined) {
      return (row[colName] as T) ?? null;
    }
    return plainRow<T>(row);
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.sqlite
      .prepare(this.sql)
      .all(...this.params)
      .map((row) => plainRow<T>(row));
    return { results: rows, success: true, meta: d1Meta(0, 0) };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    if (READ_ONLY_SQL.test(this.sql)) {
      this.sqlite.prepare(this.sql).all(...this.params);
      return { results: [] as T[], success: true, meta: d1Meta(0, 0) };
    }
    const info = this.sqlite.prepare(this.sql).run(...this.params);
    return {
      results: [] as T[],
      success: true,
      meta: d1Meta(Number(info.changes), Number(info.lastInsertRowid)),
    };
  }
}

/** 真 D1 子集：prepare 链式 + batch（与 workers-types D1Database 的方法面对齐）。 */
export interface ChatD1Database {
  prepare(sql: string): SqliteD1Statement;
  /** D1 batch：逐条执行、按序返回结果（真 D1 语义由调用方自管事务，与逐条等价）。 */
  batch<T = unknown>(statements: SqliteD1Statement[]): Promise<D1Result<T>[]>;
}

/** 测试库句柄：D1 绑定 + 直查真库的断言通道 + 列名查询（守护用例）。 */
export interface ChatTestDb {
  /** 传给 app.fetch(request, env) 的 DB 绑定。 */
  d1: ChatD1Database;
  /** 直查真库（断言真实行，不经适配器）。 */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** 直查单行。 */
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | null;
  /** 直接执行（种子数据 / 建自定义表等）。 */
  run(sql: string, ...params: unknown[]): { changes: number };
  /** 建表列名（守护用例：查询列 ↔ 建表列错位即红）。 */
  columns(table: string): string[];
  /** 底层句柄（高级用例用）。 */
  sqlite: DatabaseSync;
  close(): void;
}

/** schema-baseline.sql 的仓库内路径（schema 真值唯一来源，上游 worker 交付）。 */
export const SCHEMA_BASELINE_PATH = fileURLToPath(
  new URL('../migrations/chat/0001_baseline.sql', import.meta.url),
);

/**
 * 建一个加载真实 schema-baseline.sql 的内存库。
 * 每个用例各自建库，互不共享状态（并发/顺序都不串味）。
 */
export function createChatDb(): ChatTestDb {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(SCHEMA_BASELINE_PATH, 'utf8'));
  return {
    d1: {
      prepare: (sql: string) => new SqliteD1Statement(sqlite, sql),
      batch: async <T>(statements: SqliteD1Statement[]) => {
        const results: D1Result<T>[] = [];
        for (const statement of statements) {
          results.push(await statement.run<T>());
        }
        return results;
      },
    },
    sqlite,
    query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
      return sqlite
        .prepare(sql)
        .all(...params)
        .map((row) => plainRow<T>(row));
    },
    first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | null {
      const row = sqlite.prepare(sql).get(...params);
      return row === undefined ? null : plainRow<T>(row);
    },
    run(sql: string, ...params: unknown[]) {
      const info = sqlite.prepare(sql).run(...params);
      return { changes: Number(info.changes) };
    },
    columns(table: string): string[] {
      return sqlite
        .prepare('SELECT name FROM pragma_table_info(?)')
        .all(table)
        .map((row) => String((row as { name: unknown }).name));
    },
    close() {
      sqlite.close();
    },
  };
}

/**
 * 内存 KV（Cloudflare KV 最小面：get/put/delete）。
 * KV 本来就是 KV——Map 桩在这里是正当替身（禁项只针对无 schema 的假 D1）。
 * session 值存 JSON 字符串。
 */
export class MemoryKv {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** app.fetch(request, env) 的 env 形状（DB 真 SQLite、SESSIONS 内存 KV、vars 同 wrangler.jsonc）。 */
export interface ChatTestEnv {
  DB: ChatD1Database;
  SESSIONS: MemoryKv;
  /** #217 认证：core 公钥 JWKS JSON（验签用，每用例注入）；空串 = 未配（验签面 503）。 */
  CORE_JWKS_JSON?: string;
  /** #217 可选 iss 校验（默认不设，以 aud 锁定为主）。 */
  CORE_ISSUER?: string;
  EDGECHAT_ENCRYPTION_KEYRING: string;
  ADMIN_USERNAMES: string;
  MESSAGE_RETENTION_DAYS: string;
  SOFT_DELETE_RETENTION_DAYS: string;
  GC_BATCH_SIZE: string;
  GC_MAX_BATCHES_PER_RUN: string;
  GC_INTERNAL_OPERATION_BUDGET: string;
  GC_D1_STATEMENT_BUDGET: string;
  GC_R2_OPERATION_BUDGET: string;
  SITE_ORIGINS: string;
  R2_DELETE_MAX_RETRY: string;
  ORPHAN_UPLOAD_RETENTION_DAYS: string;
  ALLOWED_FILE_TYPES: string;
  MAX_FILE_SIZE: string;
  FILES?: unknown;
}

/** 默认 vars（与 wrangler.jsonc/.dev.vars 对齐）。 */
export const TEST_VARS: Omit<ChatTestEnv, 'DB' | 'SESSIONS'> = {
  EDGECHAT_ENCRYPTION_KEYRING: TEST_KEYRING,
  ADMIN_USERNAMES: 'admin',
  MESSAGE_RETENTION_DAYS: '7',
  SOFT_DELETE_RETENTION_DAYS: '60',
  GC_BATCH_SIZE: '90',
  GC_MAX_BATCHES_PER_RUN: '20',
  GC_INTERNAL_OPERATION_BUDGET: '900',
  GC_D1_STATEMENT_BUDGET: '1200',
  GC_R2_OPERATION_BUDGET: '300',
  SITE_ORIGINS: '',
  R2_DELETE_MAX_RETRY: '8',
  ORPHAN_UPLOAD_RETENTION_DAYS: '1',
  ALLOWED_FILE_TYPES: 'image/,video/,audio/,application/pdf,text/',
  MAX_FILE_SIZE: '20971520',
};

/** 测试用户种子入参。 */
export interface SeedUserInput {
  username: string;
  password: string;
  displayName: string;
  isAdmin?: boolean;
}

/**
 * 种子用户：直接 INSERT INTO users，密码哈希用 worker/src/auth.js 的真 hashPassword
 * （登录路由将把同样哈希算法与存储形态走通，测试不另设哈希桩）。
 */
export async function createSeedUser(
  db: ChatTestDb,
  input: SeedUserInput,
): Promise<Record<string, unknown>> {
  // 真 hashPassword：PBKDF2 派生 salt+hash（与登录路由 verifyPassword 同一套真函数）
  const { salt, hash } = await hashPassword(input.password);
  db.run(
    `INSERT INTO users (username, display_name, password_hash, password_salt, is_admin)
     VALUES (?, ?, ?, ?, ?)`,
    input.username,
    input.displayName,
    hash,
    salt,
    input.isAdmin ? 1 : 0,
  );
  return db.first('SELECT * FROM users WHERE username = ?', input.username) as Record<string, unknown>;
}
