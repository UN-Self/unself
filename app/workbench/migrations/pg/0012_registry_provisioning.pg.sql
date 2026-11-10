-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：module_registry 落点列（issue #348，决策 #103①②）
--
-- 与 core/0012_registry_provisioning.sql 同一逻辑迁移：module_registry 增
-- entry / storage_level / mode 三列，语义与不变式完全一致（见那份文件的注释）。
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

-- 写入合并语义（#348 review 定案 2026-11-10）：三列是用户选择、活过模块升级——upsert
-- 冲突分支按「本次未写（NULL）保留列中旧值」合并（control-plane sql.ts REGISTRY_UPSERT_SQL
-- 与 installer 同源副本承载）；显式传值才覆盖；entry 保留跟随生效后的 mode（显式切走
-- connect 时 entry 清 NULL，维持 CHECK 的构成定义）。清空必须走显式管理动作，装配器
-- 不承担清空职责。已应用迁移禁改，本注释不涉及列定义与 CHECK，仅补语义说明。

ALTER TABLE module_registry ADD COLUMN entry TEXT;

ALTER TABLE module_registry ADD COLUMN storage_level TEXT;

ALTER TABLE module_registry ADD COLUMN mode TEXT NOT NULL DEFAULT 'cloudflare'
  CHECK (mode IN ('cloudflare', 'docker', 'connect') AND (mode != 'connect' OR entry IS NOT NULL));
