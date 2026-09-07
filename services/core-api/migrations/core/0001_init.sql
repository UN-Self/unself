-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（CORE_DB）：核心库初始表结构

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  sub TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(issuer, sub)
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
