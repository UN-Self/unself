-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：module_registry 读写性能补强（M0 #7）
--
-- 与 core/0003_registry_index.sql 同一逻辑迁移：语句落在可移植子集上，一一对应。

CREATE INDEX IF NOT EXISTS idx_module_registry_enabled
  ON module_registry (enabled, id);
