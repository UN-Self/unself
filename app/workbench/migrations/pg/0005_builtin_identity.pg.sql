-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：内置身份（issue-A，SPEC §5.7 能力轴模型 / 决策 20/28/29/30）
--
-- 与 core/0005_builtin_identity.sql 同一逻辑迁移：语句落在可移植子集上，一一对应。
-- 密码格式、一人一行、UNIQUE 硬闸等语义见那份文件的注释。

CREATE TABLE IF NOT EXISTS builtin_credentials (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_builtin_credentials_username
  ON builtin_credentials (username);

CREATE TABLE IF NOT EXISTS invite_credentials (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  FOREIGN KEY(token_hash) REFERENCES invites(token_hash)
);
