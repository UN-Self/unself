// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/api/messages.js（GPL-3.0-only，裁剪版）
// #220 增补（unself 集成层）：逐条已读回执上报（flows.md 链路 2）；GET 分页每条消息富化 readReceipts。
import { listMessages } from '../data/messages.js';
import { getPinnedMessage } from '../data/pins.js';
import { markRoomRead } from '../data/unread.js';
import {
  countReachableRecipients,
  listReadReceipts,
  recordReadReceipts
} from '../data/read-receipts.js';
import { submitRoomReceipts } from '../do-bridge.js';
import { authorizeRoom, isRoomKind } from '../room-access.js';
import { errorResponse, sanitizeLimit } from '../utils.js';

// 单批回执上限：超过即 413（防刷屏/防大包）。
const MAX_RECEIPT_BATCH = 200;

/**
 * GET /api/messages 出参富化：每条 message 增 readReceipts {count, readBy[]}。
 * 口径（#220 定案）：count=该消息已读人数（read_receipts 真实行）；分母=可达收件人
 * （成员∧未删∧active，发件人恒已读不计入分母），每页一条成员基数查询+一条回执 IN 查询，不 N+1。
 */
async function attachReadReceipts(env, roomId, messages) {
  if (messages.length === 0) {
    return [];
  }
  const senderIds = [...new Set(messages
    .map((message) => (message.sender?.kind === 'local' ? Number(message.sender.id) : NaN))
    .filter((id) => Number.isInteger(id) && id > 0))];

  const [receiptsByMessage, memberCount] = await Promise.all([
    listReadReceipts(env.DB, messages.map((message) => message.id)),
    countReachableRecipients(env.DB, roomId)
  ]);

  return messages.map((message) => {
    const entry = receiptsByMessage.get(Number(message.id));
    const isOwn = message.sender?.kind === 'local'
      && senderIds.includes(Number(message.sender.id));
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
    await markRoomRead(c.env.DB, {
      channelId: roomId,
      userId: session.userId
    });

    // #220 补拉定案：分页内联富化（每页一条回执 IN 查询 + 一条成员基数查询，不 N+1）。
    const enriched = await attachReadReceipts(c.env, roomId, messages);

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

    let newlyRead = [];
    if (ids.length > 0) {
      // DO 是唯一写者：落行（幂等）+ diff + 聚合广播都在 ChannelRoom /receipts；
      // HTTP 面不预写，回执行由 DO 落。DO 失败 → 尽力降级到本地直写（广播不可用但不丢上报）。
      const response = await submitRoomReceipts(c.env, {
        room: access.room,
        principal: session,
        messageIds: ids
      });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        newlyRead = Array.isArray(body?.receipts)
          ? body.receipts.map((item) => ({
              messageId: Number(item.messageId),
              readAt: String(item.readAt || '')
            }))
          : [];
      } else {
        console.error(JSON.stringify({
          message: 'read receipt do submit failed',
          roomId,
          userId: session.userId,
          status: response.status
        }));
        // 降级：DO 不可达时在 HTTP 面直接落行（无广播；幂等不重不漏）。
        newlyRead = await recordReadReceipts(c.env.DB, {
          channelId: roomId,
          userId: session.userId,
          messageIds: ids
        });
      }
    }

    // 频道级未读游标（上游 message_reads，与新回执表并存不互改）。
    const lastReadMessageId = await markRoomRead(c.env.DB, {
      channelId: roomId,
      userId: session.userId,
      messageId: ids.length > 0 ? Math.max(...ids) : legacyMessageId
    });

    return c.json({
      ok: true,
      lastReadMessageId,
      receipts: newlyRead.map((item) => ({
        messageId: item.messageId,
        readAt: item.readAt
      }))
    });
  });
}
