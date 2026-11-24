-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：module_notify 通知类型（issue #243，决策 #56）
--
-- 与 core/0008_module_notify_type.sql 同一逻辑迁移；`INSERT OR IGNORE` 换成 ON CONFLICT DO NOTHING。

INSERT INTO notification_types (type, template, in_app, email) VALUES
  ('module_notify', '模块通知', 1, 0)
ON CONFLICT DO NOTHING;
