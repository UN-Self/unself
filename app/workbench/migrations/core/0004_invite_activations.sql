-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core：邀请激活令牌（#18 链路 1 完整实例）与待审批通知类型

-- 激活令牌独立成表而不是给 invites 加列：#81 起迁移必须可重复应用
-- （test/migrations.test.ts 守卫），SQLite 没有 ADD COLUMN IF NOT EXISTS；
-- 新表 CREATE TABLE IF NOT EXISTS 天然幂等。一邀请至多签一条激活令牌
-- （批准 = 开号 + 发一条激活链接，M1 不做重发；拒绝后重新生成邀请即可）。
CREATE TABLE IF NOT EXISTS invite_activations (
  token_hash TEXT PRIMARY KEY,
  invite_token_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- 填表后站内广播 active 管理员（#18 拍板：M1 无自动审批）。
-- 类型是数据不是代码（SPEC §6.6）：站内 1 / 邮件 0——管理员提醒不发邮件，
-- 也避免复用 invite_result（email=1，模板是给申请人看的结果通知）误发给管理员。
INSERT OR IGNORE INTO notification_types (type, template, in_app, email) VALUES
  ('invite_pending', '有新的加入申请待审批', 1, 0);
