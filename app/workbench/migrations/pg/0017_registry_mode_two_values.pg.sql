-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：module_registry.mode 三值收敛两值（issue #369）
--
-- 与 core/0017_registry_mode_two_values.sql 同一逻辑迁移：cloudflare / docker → direct，
-- connect 不动；值域 CHECK 换成 direct/connect 两值。语义与映射理由见那份文件的注释。
--
-- 方言分歧（#103①「分歧处分文件」的第一次真分歧）：SQLite 改不了列约束只能重建表；
-- PG 有 ALTER TABLE ... DROP CONSTRAINT / ADD CONSTRAINT，原地改、不搬数据。
-- 0012 建列时的匿名 CHECK 在 PG 里名字由服务端分配，这里按 pg_constraint 查出来再删，
-- 不猜名字（不同 PG 版本命名规则不同）。新约束起固定名，下次再改不用再查。
--
-- 迁移安全性（#61 增量安全语句 + 按文件名记账）：三条语句在同一个事务里执行
-- （PG 支持 BEGIN/COMMIT，与 D1 不同），失败整份回滚；重放安全——删不存在的约束用
-- IF EXISTS 语义（查不到就不删），ADD 前先 DROP 同名约束。
--
-- 实测版本：随 D5 落地时填写（docker compose 起真 PostgreSQL 跑全部迁移，见 PR）。

UPDATE module_registry
SET mode = CASE mode WHEN 'connect' THEN 'connect' ELSE 'direct' END;

DO $$
DECLARE
  legacy_constraint text;
BEGIN
  SELECT conname INTO legacy_constraint
  FROM pg_constraint
  WHERE conrelid = 'module_registry'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%cloudflare%';
  IF legacy_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE module_registry DROP CONSTRAINT %I', legacy_constraint);
  END IF;
END $$;

ALTER TABLE module_registry DROP CONSTRAINT IF EXISTS module_registry_mode_two_values;
-- 列 DEFAULT 也要跟着换：0012 建列时写的是 DEFAULT 'cloudflare'，只换 CHECK 不换 DEFAULT
-- 会让"省略 mode 的 INSERT"落一个旧值（SQLite 变体的 0017 重建表时已改成 'direct'，
-- 两方言的 schema 契约必须一致）。
ALTER TABLE module_registry ALTER COLUMN mode SET DEFAULT 'direct';
ALTER TABLE module_registry ADD CONSTRAINT module_registry_mode_two_values
  CHECK (mode IN ('direct', 'connect') AND (mode != 'connect' OR entry IS NOT NULL));
