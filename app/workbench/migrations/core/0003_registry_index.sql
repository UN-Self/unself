-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core：module_registry 读写性能补强（M0 #7）
-- module_registry 主键 id 已覆盖点查；这里补启停/列表扫描路径

-- 成员侧边栏/成员 token 门禁按 enabled 过滤
CREATE INDEX IF NOT EXISTS idx_module_registry_enabled
  ON module_registry (enabled, id);
