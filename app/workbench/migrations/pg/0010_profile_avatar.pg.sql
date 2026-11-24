-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：users 增 avatar_key 列
--
-- 与 core/0010_profile_avatar.sql 同一逻辑迁移：NULL = 尚未在 Core 设置；空字符串 =
-- 用户明确移除头像。部分索引在 PG 上同样成立（仅非空非空串入索引）。

ALTER TABLE users ADD COLUMN avatar_key TEXT;
CREATE INDEX IF NOT EXISTS idx_users_avatar_key ON users(avatar_key) WHERE avatar_key IS NOT NULL AND avatar_key <> '';
