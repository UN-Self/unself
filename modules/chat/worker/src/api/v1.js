// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/api/v1.js（GPL-3.0-only，裁剪版）
// #217 认证适配裁剪：删 /api/v1/auth/login|refresh|logout（移动端本地会话）与
// /api/v1/realtime/tickets、/api/v1/realtime/ws（票券 WS 通道）——JWT 直连 /api/ws/:kind/:id 取代；
// mobile-session.js / realtime-tickets.js 整文件同步删除（记录见 MIGRATION-NOTES.md）。
import { saveUploadedFile } from './upload.js';
import {
  getRoomSyncCursor,
  listMessages,
  listRoomMessageEvents
} from '../data/messages.js';
import { getSiteSettings } from '../data/site-settings.js';
import { submitClientRoomAction } from '../do-bridge.js';
import { ApiError } from '../errors.js';
import { authMiddleware } from '../middleware.js';
import { authorizeRoom, isRoomKind } from '../room-access.js';
import { markRoomRead } from '../data/unread.js';
import { errorCodeForStatus, parseJsonRequest, requestBodyTooLarge, sanitizeLimit, v1ErrorResponse } from '../utils.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_PATTERN.test(String(value || '').trim());
}

function validRoomRequest(kind, roomId) {
  return isRoomKind(kind) && Number.isInteger(roomId) && roomId > 0;
}

async function requireRoom(c) {
  const kind = String(c.req.param('kind') || '');
  const roomId = Number(c.req.param('id'));
  if (!validRoomRequest(kind, roomId)) {
    throw new ApiError('会话参数无效', 400, 'invalid_room');
  }
  const session = c.get('session');
  const access = await authorizeRoom(c.env.DB, session, kind, roomId);
  if (!access.ok) {
    throw new ApiError('无权访问该会话', 403, 'forbidden');
  }
  return { session, kind, roomId, room: access.room };
}

async function legacyProxyRequest(request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  const init = { method: request.method, headers: request.headers };
  if (!['GET', 'HEAD'].includes(request.method)) {
    // 内部复用旧路由时固化请求体，避免跨运行时传递 ReadableStream 时需要 Node duplex 扩展。
    init.body = await request.arrayBuffer();
  }
  return new Request(url.toString(), init);
}

async function convertLegacyError(response) {
  if (response.status < 400) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return response;
  const payload = await response.clone().json().catch(() => null);
  if (typeof payload?.error !== 'string') return response;
  return v1ErrorResponse(
    errorCodeForStatus(response.status),
    payload.error,
    response.status
  );
}

export function registerV1Routes(app) {
  app.get('/api/v1/capabilities', async (c) => {
    const site = await getSiteSettings(c.env.DB);
    return c.json({
      apiVersion: 1,
      site,
      limits: {
        maxUploadBytes: Number(c.env.MAX_FILE_SIZE || 20971520),
        messageRetentionDays: Number(c.env.MESSAGE_RETENTION_DAYS || 7)
      },
      features: {
        deviceSessions: true,
        realtimeTickets: true,
        idempotentMessages: true,
        idempotentUploads: Boolean(c.env.FILES),
        roomSync: true,
        backgroundPush: false
      }
    });
  });

  app.get('/api/v1/rooms/:kind/:id/messages', authMiddleware, async (c) => {
    const { roomId, room } = await requireRoom(c);
    const messages = await listMessages(
      c.env,
      roomId,
      c.req.query('before'),
      sanitizeLimit(c.req.query('limit'))
    );
    return c.json({
      room: {
        id: Number(room.id),
        kind: room.kind,
        name: room.name,
        description: room.description
      },
      messages,
      syncCursor: await getRoomSyncCursor(c.env.DB, roomId)
    });
  });

  app.get('/api/v1/rooms/:kind/:id/sync', authMiddleware, async (c) => {
    const { roomId } = await requireRoom(c);
    const cursor = Math.max(0, Number(c.req.query('cursor')) || 0);
    const result = await listRoomMessageEvents(
      c.env,
      roomId,
      cursor,
      sanitizeLimit(c.req.query('limit'), 100, 100)
    ).catch((error) => {
      if (error?.code === 'sync_cursor_expired') {
        throw new ApiError('同步游标已过期，请重新加载会话', 409, error.code);
      }
      throw error;
    });
    return c.json(result);
  });

  app.post('/api/v1/rooms/:kind/:id/messages', authMiddleware, async (c) => {
    const { session, room } = await requireRoom(c);
    const payload = await parseJsonRequest(c.req.raw);
    if (!isUuid(payload.clientMessageId)) {
      return v1ErrorResponse('client_message_id_invalid', 'clientMessageId 必须是 UUID');
    }
    return submitClientRoomAction(c.env, {
      room,
      principal: session,
      action: {
        type: 'send',
        clientMessageId: payload.clientMessageId,
			content: payload.content,
				attachment: payload.attachment || null,
				mentionUserIds: payload.mentionUserIds || [],
				replyMessageId: payload.replyMessageId ?? null
			  }
    });
  });

  app.delete('/api/v1/rooms/:kind/:id/messages/:messageId', authMiddleware, async (c) => {
    const { session, room } = await requireRoom(c);
    return submitClientRoomAction(c.env, {
      room,
      principal: session,
      action: { type: 'delete_message', messageId: Number(c.req.param('messageId')) }
    });
  });

  app.post('/api/v1/rooms/:kind/:id/read', authMiddleware, async (c) => {
    const { session, roomId } = await requireRoom(c);
    const payload = await parseJsonRequest(c.req.raw);
    const messageId = payload.messageId === undefined ? null : Number(payload.messageId);
    if (messageId !== null && (!Number.isInteger(messageId) || messageId <= 0)) {
      return v1ErrorResponse('message_id_invalid', '消息 ID 无效');
    }
    const lastReadMessageId = await markRoomRead(c.env.DB, {
      channelId: roomId,
      userId: session.userId,
      messageId
    });
    return c.json({ ok: true, lastReadMessageId });
  });

  app.post('/api/v1/uploads', authMiddleware, async (c) => {
    if (!c.env.FILES) {
      return v1ErrorResponse('attachments_unavailable', '当前部署没有绑定 R2，无法上传附件', 503);
    }
    const maxFileSize = Number(c.env.MAX_FILE_SIZE || 20971520);
    if (requestBodyTooLarge(c.req.raw, maxFileSize + 1024 * 1024)) {
      return v1ErrorResponse(
        'payload_too_large',
        `文件大小不能超过 ${Math.round(maxFileSize / 1024 / 1024)}MB`,
        413
      );
    }
    const formData = await c.req.formData();
    const file = formData.get('file');
    const clientUploadId = String(formData.get('clientUploadId') || '');
    if (!(file instanceof File)) {
      return v1ErrorResponse('file_required', '请选择文件');
    }
    if (!isUuid(clientUploadId)) {
      return v1ErrorResponse('client_upload_id_invalid', 'clientUploadId 必须是 UUID');
    }
    try {
      const result = await saveUploadedFile(c.env, c.get('session'), file, { clientUploadId });
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      const message = String(error?.message || '上传失败');
      if (message.startsWith('文件大小不能超过') || message === '该文件类型不允许上传') {
        return v1ErrorResponse('upload_rejected', message);
      }
      throw error;
    }
  });

  app.all('/api/v1/*', async (c) => {
    const currentPath = new URL(c.req.url).pathname;
    const suffix = currentPath.slice('/api/v1'.length);
    if (suffix.startsWith('/admin')) {
      return v1ErrorResponse('not_found', '接口不存在', 404);
    }
    const response = await app.fetch(
      await legacyProxyRequest(c.req.raw, `/api${suffix}`),
      c.env
    );
    return convertLegacyError(response);
  });
}
