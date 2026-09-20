// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/user-status.test.js（GPL-3.0-only，裁剪版）
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeUserSql,
  banExpiryFromMinutes,
  isUserDisabled,
  projectUserBan
} from './user-status.js';

const NOW = Date.parse('2026-08-20T10:00:00.000Z');

test('用户封禁状态同时支持永久、临时与自然到期', () => {
  assert.equal(isUserDisabled({ is_disabled: 1, disabled_until: null }, NOW), true);
  assert.equal(isUserDisabled({ is_disabled: 0, disabled_until: '2026-08-20T10:05:00.000Z' }, NOW), true);
  assert.equal(isUserDisabled({ is_disabled: 0, disabled_until: '2026-08-20T09:59:00.000Z' }, NOW), false);
  assert.equal(isUserDisabled({ is_disabled: 0, disabled_until: null }, NOW), false);
});

test('管理员用户投影不会继续展示已经到期的临时封禁', () => {
  assert.deepEqual(projectUserBan({ is_disabled: 1, disabled_until: null }, NOW), {
    isDisabled: true,
    isPermanentlyDisabled: true,
    disabledUntil: null
  });
  assert.deepEqual(projectUserBan({
    is_disabled: 0,
    disabled_until: '2026-08-20T10:05:00.000Z'
  }, NOW), {
    isDisabled: true,
    isPermanentlyDisabled: false,
    disabledUntil: '2026-08-20T10:05:00.000Z'
  });
  assert.deepEqual(projectUserBan({
    is_disabled: 0,
    disabled_until: '2026-08-20T09:59:00.000Z'
  }, NOW), {
    isDisabled: false,
    isPermanentlyDisabled: false,
    disabledUntil: null
  });
});

test('封禁截止时间按分钟计算且活跃用户 SQL 使用数据库当前时间', () => {
  assert.equal(banExpiryFromMinutes(65, NOW), '2026-08-20T11:05:00.000Z');
  assert.match(activeUserSql('u'), /u\.is_disabled = 0/);
  assert.match(activeUserSql('u'), /datetime\(u\.disabled_until\) <= CURRENT_TIMESTAMP/);
});
