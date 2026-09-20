-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core：module_notify 通知类型（issue #243，决策 #56）
--
-- 背景：permissions 门禁词表含 notify（模块向成员发站内通知）。为让「模块声明 notify
-- 即可经 /api/module-api/notify 投递」有数据行可依（通知类型是数据不是代码，#19），
-- 种一行 module_notify 类型：仅站内渠道（模块触发通知不直接发邮件——弱化实例无邮件也能用，
-- 与 module_toggled 同口径）。
--
-- 迁移安全性（按文件名记账，新迁移要能上老库）：
--   INSERT OR IGNORE：老库重放 / 新库首建均幂等。
INSERT OR IGNORE INTO notification_types (type, template, in_app, email) VALUES
  ('module_notify', '模块通知', 1, 0);
