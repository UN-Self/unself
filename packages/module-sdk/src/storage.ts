// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块键值存储抽象：模块以子域（module:<moduleId>:<key>）读写自己的数据。
 *
 * 数据边界由契约执行不靠物理分库（PRODUCT_SPEC §5.4）：SDK 收口访问、拒绝跨模块查询；
 * 本接口与 @unself/contracts 的模块生命周期契约（ModuleLifecycle.export/purge）对齐：
 * export 输出 @unself/contracts ExportBundle（按表前缀全量导出），purge 按前缀清除。
 *
 * TODO(M0)：实现走 Core API 存储适配 —— 模块后端通过
 * `POST /internal/modules/:moduleId/storage`（模块 token 鉴权）读写，
 * 由 Core API 代理到持久化层；本接口将作为 createModuleSDK 返回的 storage 实现。
 */
export interface ModuleStorage {
  /** 读取键值；不存在返回 null。 */
  get(key: string): Promise<string | null>;
  /** 写入键值。 */
  put(key: string, value: string): Promise<void>;
  /** 删除键值。 */
  delete(key: string): Promise<void>;
  /** 列出前缀下的键（未提供 prefix 时列出该模块全部键）。 */
  list(prefix?: string): Promise<string[]>;
}

/**
 * createModuleSDK 返回的完整模块环境：客户端桥 + 生命周期实现基座。
 * M0 只定义形状；生命周期方法由 SDK 供给（#8/#9）。
 */
export interface ModuleContext {
  /** 当前模块 id。 */
  moduleId: string;
  /** 模块键值存储（前缀收口后）。 */
  storage: ModuleStorage;
}
