-- SPDX-License-Identifier: AGPL-3.0-only
-- NULL = 尚未在 Core 设置；空字符串 = 用户明确移除头像。
ALTER TABLE users ADD COLUMN avatar_key TEXT;
CREATE INDEX IF NOT EXISTS idx_users_avatar_key ON users(avatar_key) WHERE avatar_key IS NOT NULL AND avatar_key != '';
