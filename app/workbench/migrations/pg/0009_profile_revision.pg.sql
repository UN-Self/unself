-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：users 增 profile_revision 列
--
-- 与 core/0009_profile_revision.sql 同一逻辑迁移：语句落在可移植子集上，一一对应。

ALTER TABLE users ADD COLUMN profile_revision INTEGER NOT NULL DEFAULT 0;
