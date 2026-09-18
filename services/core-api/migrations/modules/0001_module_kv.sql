-- SPDX-License-Identifier: AGPL-3.0-only
-- 平台基建：modules 库的模块键值表（#248，决策 #55）
--
-- 归属：core 级（`storage.declaration = core`）模块的数据经 Core API 代理
-- （services/core-api/src/routes/module-api.ts）落在本表——schema 归 core，不归任何模块
-- （docs/modules.md §4「core 的 schema 归 core」）。
-- 历史：本表原由 modules/hello/migrations/hello/0001_module_kv.sql 创建（hello 自带迁移），
-- #248 四级落点落地后升格为平台基建：任何 core 级模块（含无迁移的新模块）都必须开箱可用。
--
-- 键模型：业务键为模块子域内的裸键；模块身份表达在 module_id 列上（= 模块 token 的 aud），
-- 访问一律经代理按 aud 收口，跨子域由 core-api 拒绝。
CREATE TABLE IF NOT EXISTS module_kv (
  module_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (module_id, key)
);

-- 按模块分组/计数类查询的意图索引（PK(module_id, key) 已覆盖等值与前缀扫描）。
CREATE INDEX IF NOT EXISTS module_kv_module_id_idx ON module_kv (module_id);
