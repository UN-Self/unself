// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/user-status.js（GPL-3.0-only，裁剪版）
const MINUTE_MS = 60 * 1000;

export function activeUserSql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  // 到期时间直接在查询时判断，避免为少量时间偏差引入定时任务与额外写入。
  return `${prefix}is_disabled = 0
    AND (${prefix}disabled_until IS NULL OR datetime(${prefix}disabled_until) <= CURRENT_TIMESTAMP)`;
}

export function isUserDisabled(user, now = Date.now()) {
  if (Number(user?.is_disabled)) {
    return true;
  }

  const disabledUntil = Date.parse(user?.disabled_until || '');
  return Number.isFinite(disabledUntil) && disabledUntil > now;
}

export function banExpiryFromMinutes(durationMinutes, now = Date.now()) {
  return new Date(now + durationMinutes * MINUTE_MS).toISOString();
}

export function projectUserBan(row, now = Date.now()) {
  const isPermanentlyDisabled = Boolean(Number(row.is_disabled));
  const disabledUntilTimestamp = Date.parse(row.disabled_until || '');
  const disabledUntil = Number.isFinite(disabledUntilTimestamp) && disabledUntilTimestamp > now
    ? row.disabled_until
    : null;

  return {
    isDisabled: isPermanentlyDisabled || Boolean(disabledUntil),
    isPermanentlyDisabled,
    disabledUntil
  };
}
