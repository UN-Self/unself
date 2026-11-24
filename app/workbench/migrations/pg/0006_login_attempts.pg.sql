-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core（PostgreSQL 变体）：内置登录失败限速计数（#186 S2）
--
-- 与 core/0006_login_attempts.sql 同一逻辑迁移：语句落在可移植子集上，一一对应。
-- 计数键与窗口语义见那份文件的注释。

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
