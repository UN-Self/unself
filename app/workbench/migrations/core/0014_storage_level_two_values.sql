-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core：module_registry.storage_level 五值收敛两值（issue #349 U5，用户拍板定案）
--
-- 背景：storage_level 原值域五值（core / shared / dedicated / external + NULL），#349 走查
-- 定案收敛两值——`core`（核心代管，分表隔离）与 `self`（自托管）。旧值映射：
--   dedicated → core（核心代管 = 原 dedicated 供给形态：专属库 + 表级隔离）
--   shared    → core（同归核心代管）
--   core      → core（旧值 = 经 Core API 代理形态，供给面已收敛，值不变）
--   external  → self（自托管）
--   NULL      → NULL（未选；API 层 undefined = self，数据列不回填猜测值）
--
-- 为什么用 CASE UPDATE 而不是改列 CHECK：SQLite 的 ALTER 无 MODIFY COLUMN，
-- 0012 建列时未挂 CHECK，本迁移只做**数据映射**；两值词表由正门（registry zod
-- z.enum(['core','self'])）与 installer 同源清单承载，数据层不重复设门（与
-- 「CHECK 是构成定义、入口各自查」的 #348 分工同款）。
--
-- 迁移安全性（#61 增量安全语句 + 按文件名记账）：单条 UPDATE，条件内自限
-- （只动旧值行），重放幂等（首跑后无旧值行，再次 UPDATE 零命中）；已应用迁移
-- 禁改（按文件名记账），本文件只增不改。
--
-- 实测版本：SQLite 3.54.1（node:sqlite；CASE UPDATE 幂等重放零命中，证据见 PR）。

UPDATE module_registry SET storage_level = CASE storage_level
  WHEN 'dedicated' THEN 'core'
  WHEN 'shared'    THEN 'core'
  WHEN 'core'      THEN 'core'
  WHEN 'external'  THEN 'self'
  ELSE storage_level
END
WHERE storage_level IN ('dedicated', 'shared', 'core', 'external');
