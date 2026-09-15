// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/realtime-tickets.js（GPL-3.0-only，裁剪版）
import { decryptSecretValue, encryptSecretValue } from './encryption.js';
import { ApiError } from './errors.js';
import { hashOpaqueToken } from './mobile-session.js';
import { validateSession } from './session.js';
import { randomToken } from './utils.js';

export const REALTIME_TICKET_TTL_SECONDS = 60;

function ticketContext(tokenHash) {
  return `realtime-ticket:${tokenHash}`;
}

export async function issueRealtimeTicket(env, session, target) {
  if (!session?.deviceSessionId || session.sessionKind !== 'mobile') {
    throw new ApiError('当前会话不支持实时票据', 400, 'mobile_session_required');
  }
  const ticket = randomToken(32);
  const tokenHash = await hashOpaqueToken(ticket);
  const accessTokenCiphertext = await encryptSecretValue(
    env,
    session.token,
    ticketContext(tokenHash)
  );
  const expiresAt = new Date(Date.now() + REALTIME_TICKET_TTL_SECONDS * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
  await env.DB.prepare(
    `INSERT INTO realtime_tickets (
       token_hash, access_token_ciphertext, user_id, device_session_id,
       scope, room_kind, room_id, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      tokenHash,
      accessTokenCiphertext,
      Number(session.userId),
      String(session.deviceSessionId),
      target.scope,
      target.roomKind || null,
      target.roomId || null,
      expiresAt
    )
    .run();
  return { ticket, expiresAt: `${expiresAt.replace(' ', 'T')}Z` };
}

export async function consumeRealtimeTicket(env, ticket) {
  const cleanTicket = String(ticket || '').trim();
  if (!cleanTicket) return null;
  const tokenHash = await hashOpaqueToken(cleanTicket);
  const { results } = await env.DB.prepare(
    `UPDATE realtime_tickets
     SET consumed_at = CURRENT_TIMESTAMP
     WHERE token_hash = ?
       AND consumed_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP
     RETURNING access_token_ciphertext, user_id, device_session_id,
               scope, room_kind, room_id`
  )
    .bind(tokenHash)
    .all();
  const row = results[0];
  if (!row) return null;

  const accessToken = await decryptSecretValue(
    env,
    row.access_token_ciphertext,
    ticketContext(tokenHash)
  );
  const auth = await validateSession(env, accessToken);
  if (
    !auth.ok ||
    Number(auth.session.userId) !== Number(row.user_id) ||
    String(auth.session.deviceSessionId || '') !== String(row.device_session_id)
  ) {
    return null;
  }
  return {
    session: auth.session,
    scope: row.scope,
    roomKind: row.room_kind || '',
    roomId: row.room_id === null ? null : Number(row.room_id)
  };
}
