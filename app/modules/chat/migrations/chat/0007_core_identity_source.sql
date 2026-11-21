-- SPDX-License-Identifier: GPL-3.0-only
-- #透传：身份来源标记——区分「内置账号」与「OIDC 账号」。
-- 0006 用 core_login_name IS NULL 兼表「OIDC 用户」，但存量行未回填时同样是 NULL，
-- 于是内置账号被资料卡标成 @oidc.no-username。落一列显式来源后：
-- 'builtin' / 'oidc' 由 JIT 只信模块 token 的权威 claim（identity_source，核心 users.issuer 映射后签名）写入；
-- NULL = 来源未知（旧签发侧 token、存量未回填、mock、未升级 worker）→ 资料卡不渲染句柄行。
ALTER TABLE users ADD COLUMN core_identity_source TEXT;