// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/api/messages.js（GPL-3.0-only，裁剪版）
// #220 增补（unself 集成层）：逐条已读回执上报（flows.md 链路 2）；GET 分页每条消息富化 readReceipts。
import { listMessages } from '../data/messages.js';
import { getPinnedMessage } from '../data/pins.js';
import { advanceRoomReadCursor, listCursorReadReceipts } from '../data/unread.js';
import { activeUserSql } from '../user-status.js';
import { submitRoomReadCursor } from '../do-bridge.js';
import { authorizeRoom, isRoomKind } from '../room-access.js';
import { errorResponse, sanitizeLimit } from '../utils.js';

// 单批回执上限：超过即 413（防刷屏/防大包）。
const MAX_RECEIPT_BATCH = 200;

/**
 * GET /api/messages 出参富化：每条 message 增 readReceipts {count, readBy[]}。
 * 口径（#220 定案）：count=该消息已读人数（read_receipts 真实行）；分母=可达收件人
 * （成员∧未删∧active，发件人恒已读不计入分母），每页一条成员基数查询+一条回执 IN 查询，不 N+1。
 */
async function attachReadReceipts(env, roomId, messages, currentUserId) {
  if (messages.length === 0) {
    return [];
  }
  const visibleMessages = messages.filter((message) => !message.deleted);
  const [receiptsByMessage, memberCountResult] = await Promise.all([
    listCursorReadReceipts(env.DB, roomId, visibleMessages),
    env.DB.prepare(`SELECT COUNT(*) AS recipient_count FROM channel_members cm JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ? AND u.deleted_at IS NULL AND ${activeUserSql('u')}`).bind(Number(roomId)).all()
  ]);
  const memberCount = Number(memberCountResult.results[0]?.recipient_count || 0);

  return messages.map((message) => {
    const entry = receiptsByMessage.get(Number(message.id));
    const isOwn = message.sender?.kind === 'local'
      && Number(message.sender.id) === Number(currentUserId);
    // 分母=可达收件人（不含发件人自己）；单聊=1，A 发言 B/C 已读 → count=2（非 3）。
    const denominator = Math.max(0, memberCount - (isOwn ? 1 : 0));
    return {
      ...message,
      readReceipts: {
        count: entry ? entry.count : 0,
        readBy: entry ? entry.readBy : [],
        total: denominator
      }
    };
  });
}

export function registerMessageRoutes(app) {
  app.get('/api/messages', async (c) => {
    const session = c.get('session');
    const kind = c.req.query('kind');
    const roomId = Number(c.req.query('roomId'));
    const before = c.req.query('before');
    const limit = sanitizeLimit(c.req.query('limit'));

    if (!isRoomKind(kind) || !Number.isInteger(roomId) || roomId <= 0) {
      return errorResponse('参数无效');
    }

    const access = await authorizeRoom(c.env.DB, session, kind, roomId);

    if (!access.ok) {
      return errorResponse('无权访问该会话', 403);
    }

    const [messages, pinnedMessage] = await Promise.all([
      listMessages(c.env, roomId, before, limit),
      getPinnedMessage(c.env, roomId)
    ]);
    // GET 只加载数据，不推进已读游标；只有客户端可见性上报才改变阅读状态。
    const enriched = await attachReadReceipts(c.env, roomId, messages, session.userId);

    return c.json({
      room: {
        id: Number(access.room.id),
        kind: access.room.kind,
        name: access.room.name,
        description: access.room.description
      },
      messages: enriched,
      pinnedMessage
    });
  });

  // #220 扩展：批量已读回执上报（可见性检测触发）。幂等（INSERT OR IGNORE + 批内去重），
  // 有真实新增才走 DO 聚合广播（重放=零事件）；留旧 messageId 单值字段兼容。
  app.post('/api/messages/read', async (c) => {
    const session = c.get('session');
    let payload;
    try {
      payload = await c.req.raw.json();
    } catch {
      return errorResponse('参数无效');
    }
    const kind = String(payload?.kind || '');
    const roomId = Number(payload?.roomId);
    const legacyMessageId = payload?.messageId === undefined ? null : Number(payload.messageId);
    const hasMessageIds = Array.isArray(payload?.messageIds);
    const messageIds = hasMessageIds ? payload.messageIds : null;

    if (!isRoomKind(kind) || !Number.isInteger(roomId) || roomId <= 0) {
      return errorResponse('参数无效');
    }

    if (hasMessageIds) {
      // 批量面：≤200 且全为正整数；超限 413、形状错 400。
      if (messageIds.length > MAX_RECEIPT_BATCH) {
        return errorResponse('回执批量过大', 413);
      }
      const allValid = messageIds.every((id) => Number.isInteger(Number(id)) && Number(id) > 0);
      if (!allValid) {
        return errorResponse('参数无效');
      }
    } else if (legacyMessageId !== null && (!Number.isInteger(legacyMessageId) || legacyMessageId <= 0)) {
      return errorResponse('参数无效');
    }

    const access = await authorizeRoom(c.env.DB, session, kind, roomId);
    if (!access.ok) {
      return errorResponse('无权访问该会话', 403);
    }

    const ids = hasMessageIds
      ? [...new Set(messageIds.map((id) => Number(id)))]
      : (legacyMessageId !== null ? [legacyMessageId] : []);

    let lastReadMessageId = 0;
    let changed = false;
    if (ids.length > 0) {
      const cursor = Math.max(...ids);
      const response = await submitRoomReadCursor(c.env, {
        room: access.room,
        principal: session,
        messageId: cursor
      });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        lastReadMessageId = Number(body?.lastReadMessageId || cursor);
        changed = body?.changed === true;
      } else {
        const result = await advanceRoomReadCursor(c.env.DB, { channelId: roomId, userId: session.userId, messageId: cursor });
        lastReadMessageId = result.lastReadMessageId;
        changed = result.changed;
      }
    }

    return c.json({
      ok: true,
      lastReadMessageId,
      cursor: lastReadMessageId,
      changed,
      receipts: []
    });
  });
}
