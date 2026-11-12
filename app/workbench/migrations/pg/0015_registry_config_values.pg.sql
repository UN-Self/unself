-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：module_registry 增 config_values 列（issue #349 U8）
--
-- 与 core/0015_registry_config_values.sql 同一逻辑迁移：ADD COLUMN 可空列存模块配置值
-- （JSON {key:value}）；语义与校验纪律见那份文件的注释。
--
-- 方言政策（#103①）：迁移按方言分文件、分歧处分文件；本文件与 SQLite 变体当前
-- 落在同一可移植子集上，语句一一对应。PG 执行器归 D5（#350）；进入
-- check-migrations-upgrade 闸门前按目录登记种子，本 issue 只保证与 core 变体同构。
--
-- 实测版本：本文件当前无 PG 执行器消费（D5 才接），生产定案须注明实测 PG 版本
-- ——该义务随 D5 落地，本 issue 不冒领。

ALTER TABLE module_registry ADD COLUMN config_values TEXT;
