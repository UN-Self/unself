-- SPDX-License-Identifier: AGPL-3.0-only
-- #323：撤回/移除只保留 90 天审计元数据，不保存正文或附件副本。
CREATE TABLE IF NOT EXISTS message_deletion_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('recalled', 'removed')),
  source TEXT NOT NULL DEFAULT 'chat',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (message_id, action),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_message_deletion_audit_created
  ON message_deletion_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_message_deletion_audit_channel
  ON message_deletion_audit(channel_id, created_at DESC);
