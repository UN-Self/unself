-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core：module_registry 增 lifecycle 列（issue #349 待激活/已启用/已停用）
--
-- 背景：connect 反连（决策 #109 两段式）需要区分三种模块状态——记账但尚未「测试连接→
-- 保存」的 pending、管理员启用后的 active、管理员停用后的 disabled。enabled 继续承载
-- 「是否对成员/壳开放」的既有门禁语义（token 签发、导航、frame-src 白名单都只认它），
-- lifecycle 承载「模块装到哪一步」的生命周期事实；两者不合并：
--   - 第①段 connect-register 新建行：lifecycle=pending、enabled=0——pending 仍允许拨号
--     做测试连接（握手只拒 disabled）；
--   - 第②段保存（既有 admin upsert enabled=true）或 toggle on：lifecycle=active；
--   - 停用：disabled 且 enabled=0。
--
-- 升级回填：enabled=1 → active，enabled=0 → disabled。列带 DEFAULT 'pending' 且 NOT NULL，
-- 保证升级/直写不会留下 NULL 这种第五种状态；非 connect 模块同样写这列（启停语义不变）。
-- 重放安全：UPDATE 按 enabled 重算，幂等；ADD COLUMN 由迁移记账（按文件名）保证只跑一次。
--
-- 迁移安全性（#61 增量安全语句 + 按文件名记账）：ADD COLUMN 可空默认列 + 一条全表
-- UPDATE，无外部依赖，失败停住不记账。
--
-- 实测版本：SQLite 3.54.1（node:sqlite；ADD COLUMN NOT NULL DEFAULT + 回填 UPDATE）。

ALTER TABLE module_registry ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'pending';

UPDATE module_registry SET lifecycle = CASE WHEN enabled = 1 THEN 'active' ELSE 'disabled' END;
