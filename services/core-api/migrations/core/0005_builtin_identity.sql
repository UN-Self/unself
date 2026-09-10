-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core：内置身份（issue-A，SPEC §5.7 能力轴模型 / 决策 20/28/29/30）
--
-- 为什么是独立新表而不是给 users/invites 加列：SQLite 无 ADD COLUMN IF NOT
-- EXISTS，ALTER 语句天然不幂等；两处重放入口——wrangler d1 migrations apply
-- 靠 d1_migrations 记账跳过已应用文件，但 test/migrations.test.ts 的守卫是
-- 同一内存库重放全部迁移文件（#81 升级纪律 + #56 幻影列守护），ALTER 重放
-- 必然「duplicate column」炸。0004 已立先例：新表 CREATE TABLE IF NOT
-- EXISTS 天然幂等。users/invites 原表零改动，凭证各归其表，一表一职责。
--
-- 密码格式：pbkdf2-sha256$<iter>$<salt-b64>$<hash-b64>（src/services/passwords.ts）。
-- users 一人至多一行（主键同 users.id）；invites 一链接至多一行（主键同 token_hash）。

CREATE TABLE IF NOT EXISTS builtin_credentials (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- 登录按 username 点查；UNIQUE 硬闸（决策 30 批准撞名 → 可恢复 409）
CREATE UNIQUE INDEX IF NOT EXISTS idx_builtin_credentials_username
  ON builtin_credentials (username);

CREATE TABLE IF NOT EXISTS invite_credentials (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  FOREIGN KEY(token_hash) REFERENCES invites(token_hash)
);
