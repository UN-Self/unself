-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：module_registry 增 credential_hash 列（issue #349，决策 #108）
--
-- 与 core/0013_registry_credential.sql 同一逻辑迁移：module_registry 增
-- credential_hash TEXT 可空列，语义与不变式完全一致（见那份文件的注释）。
--
-- 方言政策（#103①）：迁移按方言分文件、分歧处分文件——本文件与 SQLite 变体当前
-- 落在同一可移植子集上，语句一一对应；D5 接 PG 时若出现真分歧（如跨列约束需走
-- ALTER TABLE ... ADD CONSTRAINT 形态），在此文件内演进而 SQLite 侧不动。
--
-- 放置说明：pg/ 子目录与 core/ 平行、互不扫描——D1 侧三个执行器
-- （wrangler d1 migrations、installer readSqlFiles、check-migrations-upgrade
-- 的 core 单元）都只读各自目录，PG 变体不会被任何 SQLite 执行器误应用。
-- 目录进入 check-migrations-upgrade 闸门（#248 自动发现）前，先在 LEGACY_SEEDS
-- 按目录登记种子；接闸门属 D5 范围，本 issue 只保证目录存在且内容与 core 变体同构。
--
-- 实测版本：本文件当前无 PG 执行器消费（D5 才接），生产定案须注明实测 PG 版本
-- ——该义务随 D5 落地，本 issue 不冒领。

ALTER TABLE module_registry ADD COLUMN credential_hash TEXT;
