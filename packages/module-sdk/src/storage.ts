// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块键值存储抽象：模块在自己的子域（moduleId）内读写键值数据。
 *
 * 数据边界由契约执行不靠物理分库（PRODUCT_SPEC §5.4）：SDK 收口访问、拒绝跨模块查询；
 * 与 @unself/contracts 的模块生命周期契约（ModuleLifecycle.export/purge）对齐：
 * export 输出 ExportBundle（按表前缀全量导出），purge 按前缀清除。
 * 实现收口（createD1Storage）：模块 Worker 只持 MODULES_DB 绑定与自己的 moduleId，
 * 拿不到裸连接的其他模块数据；跨前缀访问（key 含保留分隔符 ':'）一律抛错。
 */
export interface ModuleStorage {
  /** 读取键值；不存在返回 null。 */
  get(key: string): Promise<string | null>;
  /** 写入键值（覆盖写）。 */
  put(key: string, value: string): Promise<void>;
  /** 删除键值（幂等：不存在也成功）。 */
  delete(key: string): Promise<void>;
  /** 列出前缀下的键（未提供 prefix 时列出该模块全部键），按键排序。 */
  list(prefix?: string): Promise<string[]>;
}

/**
 * D1 prepared statement 最小面：与 @cloudflare/workers-types 的
 * D1PreparedStatement 结构兼容（bind/first/all/run），但不引入该类型依赖——
 * module-sdk 是第三方模块直接用到的包，不能在类型上强绑 workers 运行时。
 */
export interface D1MinimalStatement {
  bind(...values: unknown[]): D1MinimalStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

/**
 * D1 最小结构类型：{ prepare(sql): { bind(...): { first/all/run } } }。
 * wrangler 的 MODULES_DB 绑定与测试用内存假 D1 均满足该形状。
 */
export interface D1MinimalDatabase {
  prepare(sql: string): D1MinimalStatement;
}

export interface CreateD1StorageOptions {
  /** 模块 Worker 的 MODULES_DB 绑定（或兼容的最小 D1 结构，见 D1MinimalDatabase）。 */
  db: D1MinimalDatabase;
  /** 模块 id（如 'hello'）；所有操作的子域边界，SQL 恒带该条件。 */
  moduleId: string;
  /** 表名，默认 'module_kv'；只接受纯标识符（[A-Za-z0-9_]），防表名注入。 */
  table?: string;
}

/** moduleId 只允许常规标识符：字母/数字开头，后续 [A-Za-z0-9_-]。 */
const MODULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** 表名白名单，防止把任意字符串拼进 SQL。 */
const TABLE_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * 键守卫：业务键必须是模块子域内的「裸键」——非空，且不得包含保留分隔符 ':'。
 *
 * 键模型（module_id 列方案，与 `<moduleId>:<key>` 复合键二选一，选本方案）：
 * - 单表 module_kv 的行 = (module_id, key, value)，PK(module_id, key)；
 * - moduleId 由 SDK 作为独立列写入，SQL 恒带 `module_id = ?` 条件，
 *   权限边界不依赖键解析，也就不存在「拼进别的 module_id」的可能；
 * - 业务键保持原样（不带前缀），list 返回的也是裸键，与 get/put/delete 入参同构；
 * - 与复合键方案等价（最终限定键形如 `<moduleId>:<key>`），但查询更简单、免解析。
 *
 * 守卫语义：':' 是保留分隔符（最终限定键的拼合符），key 里出现 ':' 一律视为
 * 越权前缀注入——包括 `other:xxx`（别人模块前缀）、`evil::`（双冒号注入形态）、
 * `hello:counter`（自带本模块前缀的二次限定），全部 throw。
 */
function assertKey(key: string, moduleId: string): void {
  if (key.length === 0) {
    throw new Error(`storage: key 必须为非空字符串（moduleId=${moduleId}）`);
  }
  if (key.includes(':')) {
    throw new Error(
      `storage: key ${JSON.stringify(key)} 含保留分隔符 ':'，拒绝跨前缀访问（moduleId=${moduleId}）`,
    );
  }
}

/** LIKE 模式转义：把用户前缀里的 \, %, _ 转义为字面量。 */
function escapeLike(prefix: string): string {
  return prefix
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * 创建收口到 modules 库的模块键值存储。
 *
 * 所有 SQL 永远带 moduleId 条件；key 一律经 assertKey 守卫，跨前缀直接抛错。
 */
export function createD1Storage(options: CreateD1StorageOptions): ModuleStorage {
  const { db, moduleId } = options;
  const table = options.table ?? 'module_kv';

  if (!MODULE_ID_PATTERN.test(moduleId)) {
    throw new Error(`storage: 非法 moduleId ${JSON.stringify(moduleId)}`);
  }
  if (!TABLE_PATTERN.test(table)) {
    throw new Error(`storage: 非法表名 ${JSON.stringify(table)}（仅允许 [A-Za-z0-9_]）`);
  }

  const selectSql = `SELECT value FROM ${table} WHERE module_id = ? AND key = ?`;
  const upsertSql =
    `INSERT INTO ${table} (module_id, key, value) VALUES (?, ?, ?) ` +
    `ON CONFLICT(module_id, key) DO UPDATE SET value = excluded.value`;
  const deleteSql = `DELETE FROM ${table} WHERE module_id = ? AND key = ?`;
  const listSql = `SELECT key FROM ${table} WHERE module_id = ? ORDER BY key`;
  const listPrefixSql =
    `SELECT key FROM ${table} WHERE module_id = ? AND key LIKE ? ESCAPE '\\' ORDER BY key`;

  return {
    async get(key: string): Promise<string | null> {
      assertKey(key, moduleId);
      const row = await db.prepare(selectSql).bind(moduleId, key).first<{ value: string }>();
      return row?.value ?? null;
    },

    async put(key: string, value: string): Promise<void> {
      assertKey(key, moduleId);
      await db.prepare(upsertSql).bind(moduleId, key, value).run();
    },

    async delete(key: string): Promise<void> {
      assertKey(key, moduleId);
      await db.prepare(deleteSql).bind(moduleId, key).run();
    },

    async list(prefix?: string): Promise<string[]> {
      // 空 prefix（'' 或 undefined）等价于全量列出。
      if (prefix !== undefined && prefix.length > 0) {
        assertKey(prefix, moduleId);
      }
      if (prefix !== undefined && prefix.length > 0) {
        const { results } = await db
          .prepare(listPrefixSql)
          .bind(moduleId, `${escapeLike(prefix)}%`)
          .all<{ key: string }>();
        return results.map((row) => row.key);
      }
      const { results } = await db.prepare(listSql).bind(moduleId).all<{ key: string }>();
      return results.map((row) => row.key);
    },
  };

/**
 * createModuleSDK 返回的完整模块环境：客户端桥 + 生命周期实现基座。
 * 生命周期方法（export/purge）由 SDK 供给（#8/#9 契约对齐）。
 */
export interface ModuleContext {
  /** 当前模块 id。 */
  moduleId: string;
  /** 模块键值存储（前缀收口后）。 */
  storage: ModuleStorage;
}
}
