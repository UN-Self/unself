-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core：module_registry 落点列（issue #348，决策 #103②）
--
-- 背景：部署落点是模块级自由变量（#101/#343）。registry 原来只回答「装了什么」
-- （enabled + manifest 快照），本迁移补「跑在哪（mode）、从哪接入（entry）、
-- 数据落哪（storage_level）」三列——用户在这台实例上的实际选择，非 manifest 声明
-- 快照（manifest 随注册刷新被覆盖，用户选择必须活过模块升级）。
--
-- 语义：
--   mode           落点形态：cloudflare / docker / connect（D4 接入）
--   entry          connect 模式的接入 URL（其余模式 NULL）；connect 必填由下方 CHECK 承载
--   storage_level  存储四级（决策 #55）：core / shared / dedicated / external；NULL = 未选
--
-- 两个平行入口共守同一数据不变式（正门 API zod 与装配期 installer 直写各自校验，
-- CHECK 是数据层的构成定义，不是谁给谁兜底）：
--   - 任何写入路径塞进「connect 而 entry 为空」或非法 mode 值，数据库层面直接拒收。
--
-- 迁移安全性（#61 增量安全语句 + 按文件名记账）：
--   三条 ADD COLUMN 纯增量；存量行经 DEFAULT 得 mode='cloudflare'——现网全部模块
--   都是 CF 落点，语义正确；重放幂等（已加列的老库重跑报 duplicate column，
--   但按文件名记账后不会重入，新库首建亦一次通过）。
--
-- 实测版本：SQLite 3.54.1（node:sqlite；ADD COLUMN 列级 CHECK 引用同表既有列
-- entry 可行，INSERT/UPDATE 违规均被拒，证据见 issue/PR）。

-- 写入合并语义（#348 review 定案 2026-11-10）：三列是用户选择、活过模块升级——upsert
-- 冲突分支按「本次未写（NULL）保留列中旧值」合并（control-plane sql.ts REGISTRY_UPSERT_SQL
-- 与 installer 同源副本承载）；显式传值才覆盖；entry 保留跟随生效后的 mode（显式切走
-- connect 时 entry 清 NULL，维持 CHECK 的构成定义）。清空必须走显式管理动作，装配器
-- 不承担清空职责。已应用迁移禁改，本注释不涉及列定义与 CHECK，仅补语义说明。

ALTER TABLE module_registry ADD COLUMN entry TEXT;

ALTER TABLE module_registry ADD COLUMN storage_level TEXT;

ALTER TABLE module_registry ADD COLUMN mode TEXT NOT NULL DEFAULT 'cloudflare'
  CHECK (mode IN ('cloudflare', 'docker', 'connect') AND (mode != 'connect' OR entry IS NOT NULL));
