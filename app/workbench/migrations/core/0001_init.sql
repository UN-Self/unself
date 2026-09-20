-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（CORE_DB）：核心库初始表结构

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  sub TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  personal_email TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(issuer, sub)
);

CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'consumed', 'expired')),
  personal_email TEXT NOT NULL,
  email_prefix TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_types (
  type TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  in_app INTEGER NOT NULL DEFAULT 1,
  email INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO notification_types (type, template, in_app, email) VALUES
  ('invite_result', '邀请申请结果', 1, 1),
  ('account_ready', '账号已开通', 1, 1),
  ('module_toggled', '模块状态已更新', 1, 0);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  invited_email TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS module_registry (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  manifest_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acl (
  resource TEXT NOT NULL,
  user_id TEXT NOT NULL,
  perm TEXT NOT NULL,
  PRIMARY KEY(resource, user_id, perm)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
