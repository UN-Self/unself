-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core：内置登录失败限速计数（#186 S2）
--
-- 为什么是新表而不是从 audit_log 派生：审计是只增留痕，没有「成功清零」语义，
-- 派生计数要扫全表；且 audit_log 属 #188 改造面，本轮不动它的结构。
-- 计数键 `u:<username>` / `ip:<addr>` 同表两轴（见 src/services/rate-limit.ts）；
-- 成功登录删行 = 清零。window_start 存 epoch 秒整数，窗口判定在应用层做
-- （不依赖 SQLite 时间函数，测试可直接构造过期窗口）。
--
-- CREATE TABLE IF NOT EXISTS 天然幂等：migrations.test.ts 会在同一内存库重放
-- 全部迁移文件（#81 升级纪律 + #56 幻影列守护），ALTER 重放必炸（0005 先例）。

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
