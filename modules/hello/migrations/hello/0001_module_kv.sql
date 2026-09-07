-- SPDX-License-Identifier: AGPL-3.0-only
-- modules 库统一模块 KV 表：module_id 列隔离（行级子域），SDK 收口访问。
-- 键模型：业务键为模块子域内裸键，SDK 恒带 module_id 条件，跨前缀由 SDK 拒绝。
-- 表非模块前缀命名（module_kv），因为它是全模块共享的 SDK 基础设施表，
-- 模块身份在 module_id 列上表达（与「表前缀 = 模块 id」契约不冲突：
-- 模块自己的业务表仍按 hello_ 前缀命名，参见 0001_init.sql）。
CREATE TABLE IF NOT EXISTS module_kv (
  module_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (module_id, key)
);

-- 按模块前缀的聚合/统计类查询索引；PK(module_id, key) 已覆盖等值 + 键前缀扫描，
-- 此索引让「按 module_id 分组/计数」类操作意图明确且可用到索引。
CREATE INDEX IF NOT EXISTS module_kv_module_id_idx ON module_kv (module_id);
