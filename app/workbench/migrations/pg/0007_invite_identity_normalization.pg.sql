-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：邀请/身份唯一性归一（#190 B9）
--
-- 与 core/0007_invite_identity_normalization.sql 同一逻辑迁移：语句落在可移植子集上，
-- 一一对应。升级前预检与取舍理由见那份文件的注释。

CREATE UNIQUE INDEX IF NOT EXISTS idx_builtin_credentials_username_lower
  ON builtin_credentials (lower(username));
