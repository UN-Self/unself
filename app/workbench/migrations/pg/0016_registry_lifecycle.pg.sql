-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：module_registry 增 lifecycle 列（issue #349）
--
-- 与 core/0016_registry_lifecycle.sql 同一逻辑迁移：ADD COLUMN lifecycle 并回填
-- enabled=1 → active、enabled=0 → disabled；语义（pending/active/disabled 与 enabled
-- 的分工）见那份文件的注释。
--
-- 方言政策（#103①）：迁移按方言分文件、分歧处分文件；本文件与 SQLite 变体当前
-- 落在同一可移植子集上，语句一一对应。PG 执行器归 D5（#350）；进入
-- check-migrations-upgrade 闸门前按目录登记种子，本 issue 只保证与 core 变体同构。
--
-- 实测版本：本文件当前无 PG 执行器消费（D5 才接），生产定案须注明实测 PG 版本
-- ——该义务随 D5 落地，本 issue 不冒领。

ALTER TABLE module_registry ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'pending';

UPDATE module_registry SET lifecycle = CASE WHEN enabled = 1 THEN 'active' ELSE 'disabled' END;
