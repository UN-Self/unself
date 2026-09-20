-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core：setup / OIDC 会话所需补表（M0 #5 / #6）

-- 实例配置（setup 向导录入；§5.5：OIDC 不进 unself.config.jsonc）
CREATE TABLE IF NOT EXISTS instance_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 一次性 setup token（§5.2：用后立即封死）
CREATE TABLE IF NOT EXISTS setup_tokens (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT,
  used_by TEXT
);
