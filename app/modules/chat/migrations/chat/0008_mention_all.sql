-- SPDX-License-Identifier: AGPL-3.0-only
-- @all（@所有人）：仅群主可用（契约见 docs/requirements.md 4.1）。0 = 普通消息，1 = 服务端复核通过的 @all。
ALTER TABLE messages ADD COLUMN mention_all INTEGER NOT NULL DEFAULT 0;
