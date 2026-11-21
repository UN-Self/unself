-- SPDX-License-Identifier: GPL-3.0-only
-- #透传：核心身份字段落 chat users 表——登录用户名（builtin_credentials.username）与
-- 工作邮箱（核心 users.email）随模块 token claims（username/email，均有才带）进 JIT。
-- 旧列 username 是 core:<sub> JIT 幂等锚点，不可复用；新列可 NULL（OIDC 用户/未开户均合法缺省）。
ALTER TABLE users ADD COLUMN core_login_name TEXT;
ALTER TABLE users ADD COLUMN core_email TEXT;
