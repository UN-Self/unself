-- SPDX-License-Identifier: AGPL-3.0-only
-- 表前缀 = 模块 id（hello_），符合 unself 表前缀契约
CREATE TABLE IF NOT EXISTS hello_counter (
  scope TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);
