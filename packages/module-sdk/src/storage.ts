// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块键值存储抽象：模块以子域（module:<moduleId>:<key>）读写自己的数据。
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
