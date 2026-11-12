-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：module_registry.storage_level 五值收敛两值（issue #349 U5）
--
-- 与 core/0014_storage_level_two_values.sql 同一逻辑迁移：存量值映射
-- dedicated/shared/core → core、external → self、NULL 不动；语义与映射表见那份文件的注释。
--
-- 方言政策（#103①）：迁移按方言分文件、分歧处分文件；本文件与 SQLite 变体当前
-- 落在同一可移植子集上，语句一一对应。PG 执行器归 D5（#350）；进入
-- check-migrations-upgrade 闸门前按目录登记种子，本 issue 只保证与 core 变体同构。
--
-- 实测版本：本文件当前无 PG 执行器消费（D5 才接），生产定案须注明实测 PG 版本
-- ——该义务随 D5 落地，本 issue 不冒领。

UPDATE module_registry SET storage_level = CASE storage_level
  WHEN 'dedicated' THEN 'core'
  WHEN 'shared'    THEN 'core'
  WHEN 'core'      THEN 'core'
  WHEN 'external'  THEN 'self'
  ELSE storage_level
END
WHERE storage_level IN ('dedicated', 'shared', 'core', 'external');
