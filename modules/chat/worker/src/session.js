// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/session.js（GPL-3.0-only，裁剪版）
import { deleteSession, getSession, isAdminUser, putSession } from './auth.js';
import { isUserDisabled } from './user-status.js';

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export async function validateSession(env, token) {
  const session = await getSession(env, token);
  if (!session) {
    return { ok: false, status: 401, message: '请先登录' };
  }

  const { results } = await env.DB.prepare(
    `SELECT username, is_disabled, disabled_until, deleted_at, session_version, is_admin
     FROM users
     WHERE id = ?
     LIMIT 1`
  )
    .bind(session.userId)
    .all();

  const user = results[0];
  if (!user || user.deleted_at || isUserDisabled(user)) {
    await deleteSession(env, token);
    return { ok: false, status: 401, message: '账号已不可用' };
  }

  if (session.deviceSessionId) {
    const device = await env.DB.prepare(
      `SELECT session_version
       FROM device_sessions
       WHERE id = ?
         AND user_id = ?
         AND revoked_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP
       LIMIT 1`
    )
      .bind(String(session.deviceSessionId), session.userId)
      .all();
    const deviceSession = device.results[0];
    if (!deviceSession || toNumber(deviceSession.session_version) !== toNumber(user.session_version)) {
      await deleteSession(env, token);
      return { ok: false, status: 401, message: '设备登录已失效，请重新登录' };
    }
  }

  const dbVersion = toNumber(user.session_version);
  const sessionVersion = toNumber(session.sessionVersion);
  if (sessionVersion !== dbVersion) {
    await deleteSession(env, token);
    return { ok: false, status: 401, message: '登录已过期，请重新登录' };
  }

  const refreshed = {
    ...session,
    isAdmin: isAdminUser(env, user),
    sessionVersion: dbVersion
  };

  if (refreshed.isAdmin !== session.isAdmin || refreshed.sessionVersion !== session.sessionVersion) {
    await putSession(env, refreshed);
  }

  return { ok: true, session: refreshed };
}

