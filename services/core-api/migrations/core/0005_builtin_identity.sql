-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core：内置身份（#issue-A，SPEC §5.7 能力轴模型 / 决策 20/28/29/30）
--
-- 为什么是独立新表而不是给 users/invites 加列：#81 升级纪律——已入主的迁移
-- 永不修改，0001 的 users UNIQUE(issuer, sub) 与 invites 无 username 是既成
-- 事实；SQLite 无 ADD COLUMN IF NOT EXISTS，ALTER ADD COLUMN + 补 UNIQUE 索引
-- 在重复 apply（test/migrations.test.ts 守卫）时必然「duplicate column」炸。
-- 新表 CREATE TABLE IF NOT EXISTS 天然幂等，一文件一职责。
--
-- 密码格式：pbkdf2-sha256$<iter>$<salt-b64>$<hash-b64>（src/services/passwords.ts）。
-- users 一人至多一行（主键同 users.id）；invites 一链接至多一行（主键同 token_hash）。

CREATE TABLE IF NOT EXISTS builtin_credentials (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- 登录按 username 点查；UNIQUE 多 NULL 无关——此表行存在即内置用户
CREATE UNIQUE INDEX IF NOT EXISTS idx_builtin_credentials_username
  ON builtin_credentials (username);

CREATE TABLE IF NOT EXISTS invite_credentials (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  FOREIGN KEY(token_hash) REFERENCES invites(token_hash)
);
