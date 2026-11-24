-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：setup / OIDC 会话所需补表（M0 #5 / #6）
--
-- 与 core/0002_setup_oidc.sql 同一逻辑迁移；仅时间默认值换成 PG 的 to_char 文本形态。

-- 实例配置（setup 向导录入；§5.5：OIDC 不进 unself.config.jsonc）
CREATE TABLE IF NOT EXISTS instance_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- 一次性 setup token（§5.2：用后立即封死）
CREATE TABLE IF NOT EXISTS setup_tokens (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  used_at TEXT,
  used_by TEXT
);
