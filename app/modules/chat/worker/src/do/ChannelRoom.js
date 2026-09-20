// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/do/ChannelRoom.js（GPL-3.0-only，裁剪版）
import {
  MessageSubmissionError,
  submitRoomMessage,
  submitRoomMessageIdempotent
} from '../message-submission.js';
import { deleteRoomMessage, MessageDeletionError } from '../message-deletion.js';
import {
  MessagePinningError,
  pinRoomMessage,
  unpinRoomMessage
} from '../message-pinning.js';
import { submitExternalMessage } from '../external-message-submission.js';
import { recordReadReceipts } from '../data/read-receipts.js';
import { isGroupChannelKind } from '../../../shared/group-channel.ts';
import { verifyAccessToken } from '../core-auth.js';
import { jitEnsureUser, jitResolveUser } from '../jit-users.js';
import { authorizeRoom } from '../room-access.js';
import { projectUnreadMessage } from '../unread-projection.js';
import { isVerifiedInternalRequest, parseVerifiedPrincipal } from '../verified-identity.js';
import { durableObjectHealth } from '../maintenance/do-health.ts';

const MESSAGE_SIZE_LIMIT = 10 * 1024;

// #217：socket 元数据改为携带已验签的 claims（JSON 可序列化，随 attachment 持久化），
// 不再存 token 字符串（短时效 JWT 存 DO 内存无意义，且按消息重验只需 exp/iss/sub）。
function socketMeta(claims, principal, room) {
  return {
    principal: {
      userId: principal.userId,
      isAdmin: principal.isAdmin === true,
      claims
    },
    room
  };
}

function sendSocketError(ws, message) {
  try {
    ws.send(JSON.stringify({ protocolVersion: 1, type: 'error', error: message }));
  } catch {
    // Ignore broken sockets.
  }
}

function getMessageByteLength(message) {
  if (typeof message === 'string') {
    return new TextEncoder().encode(message).length;
  }
  if (message instanceof ArrayBuffer) {
    return message.byteLength;
  }
  if (ArrayBuffer.isView(message)) {
    return message.byteLength;
  }

  // 未知 WebSocket 消息类型无法可靠解析，按超大处理，避免绕过大小限制。
  return Number.MAX_SAFE_INTEGER;
}

function normalizeWebSocketMessage(message) {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return new TextDecoder().decode(message);
  }
  if (ArrayBuffer.isView(message)) {
    return new TextDecoder().decode(message);
  }
  return '';
}

export class ChannelRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = new Map();

    for (const socket of this.state.getWebSockets()) {
      const meta = socket.deserializeAttachment();
      if (meta) {
        this.connections.set(socket, meta);
      }
    }
  }

  parsePayload(ws, message) {
    try {
      return JSON.parse(message);
    } catch {
      sendSocketError(ws, 'Invalid message payload');
      return null;
    }
  }

  async revalidateConnection(ws, meta) {
    // #217 按消息重验：验「当前绑定的 JWT」而非本地会话——
    // ① claims 未过期（exp ≥ now）；② jit 停用复查（issuer+sub → users 行）；③ 房间授权。
    const claims = meta?.principal?.claims;
    const exp = Number(claims?.exp);
    if (!claims || !Number.isFinite(exp) || exp * 1000 <= Date.now()) {
      this.closeUnauthorizedSocket(ws);
      return null;
    }

    const ensured = await jitResolveUser(this.env.DB, claims);
    if (!ensured.ok) {
      this.closeUnauthorizedSocket(ws);
      return null;
    }

    const principal = { userId: ensured.user.id, isAdmin: false };
    const access = await authorizeRoom(this.env.DB, principal, meta.room.kind, meta.room.id);
    if (!access.ok) {
      this.closeUnauthorizedSocket(ws);
      return null;
    }

    const nextMeta = socketMeta(claims, principal, access.room);
    this.connections.set(ws, nextMeta);
    ws.serializeAttachment(nextMeta);
    return nextMeta;
  }

  // #217 token 续期（决策 #51 定案 C）：已建连 socket 收到新 token → 当场验签 + JIT + 房间授权 →
  // 原子换绑（connections + serializeAttachment）→ ack；任一步失败回 null，由调用方 closeUnauthorizedSocket。
  // 允许当前绑定已过期时刷新（这正是续期场景）——过期核查只发生在按消息重验里。
  async refreshSocketToken(ws, meta, payload) {
    const token = typeof payload?.token === 'string' ? payload.token : '';
    const verified = await verifyAccessToken(this.env, token);
    if (!verified.ok) {
      return null;
    }
    const ensured = await jitEnsureUser(this.env.DB, verified.claims);
    if (!ensured.ok) {
      return null;
    }
    const principal = { userId: ensured.user.id, isAdmin: false };
    const access = await authorizeRoom(
      this.env.DB,
      principal,
      meta.room?.kind,
      meta.room?.id
    );
    if (!access.ok) {
      return null;
    }

    const nextMeta = socketMeta(verified.claims, principal, access.room);
    this.connections.set(ws, nextMeta);
    ws.serializeAttachment(nextMeta);
    ws.send(JSON.stringify({ protocolVersion: 1, type: 'token_refreshed' }));
    return nextMeta;
  }

  closeUnauthorizedSocket(ws) {
    this.connections.delete(ws);
    try {
      ws.close(1008, 'Unauthorized');
    } catch {
      // Ignore broken sockets.
    }
  }

  async broadcast(packet) {
    const connections = [...this.connections.entries()];
    const validated = await Promise.all(
      connections.map(async ([socket, meta]) => ({
        socket,
        meta: await this.revalidateConnection(socket, meta)
      }))
    );

    for (const { socket, meta } of validated) {
      if (!meta) continue;
      try {
        socket.send(packet);
      } catch {
        this.connections.delete(socket);
      }
    }
  }

  runMessageProjections(room, message, replyToSenderId = null) {
    this.state.waitUntil(
      projectUnreadMessage(this.env, {
        room,
        senderId: message.sender.kind === 'local' ? message.sender.id : null,
        message,
        replyToSenderId
      })
    );
  }

  runAttachmentCleanup(result) {
    if (result.cleanupPromise) {
      this.state.waitUntil(result.cleanupPromise);
    }
  }

  async receiveExternalMessage(request) {
    if (!isVerifiedInternalRequest(request)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const payload = await request.json();
    const room = payload.room;
    if (!isGroupChannelKind(room?.kind) || !Number.isInteger(Number(room.id))) {
      return new Response('Invalid room', { status: 400 });
    }

    const result = await submitExternalMessage(this.env, { room, payload });
    if (result.created) {
      await this.broadcast(result.packet);
      this.runMessageProjections(room, result.message, result.replyToSenderId);
    }
    return Response.json({ ok: true, created: result.created, message: result.message });
  }

  async receiveClientAction(request) {
    if (!isVerifiedInternalRequest(request)) {
      return Response.json(
        { error: { code: 'authentication_required', message: '请先登录' } },
        { status: 401 }
      );
    }

    const principal = parseVerifiedPrincipal(request);
    const payload = await request.json();
    const room = payload.room;
    const action = payload.action;
    const access = principal
      ? await authorizeRoom(this.env.DB, principal, room?.kind, Number(room?.id))
      : { ok: false };
    if (!access.ok) {
      return Response.json(
        { error: { code: 'forbidden', message: '无权访问该会话' } },
        { status: 403 }
      );
    }

    const meta = { principal, room: access.room };
    try {
      if (action?.type === 'send') {
        const result = await submitRoomMessageIdempotent(this.env, meta, action);
        if (result.created) {
          await this.broadcast(result.packet);
          this.runMessageProjections(access.room, result.message, result.replyToSenderId);
        }
        return Response.json({ created: result.created, message: result.message });
      }
      if (action?.type === 'delete_message') {
        const result = await deleteRoomMessage(this.env, meta, action);
        await this.broadcast(result.packet);
        this.runAttachmentCleanup(result);
        return Response.json({ ok: true, messageId: result.messageId });
      }
      if (action?.type === 'pin_message') {
        const result = await pinRoomMessage(this.env, meta, action);
        await this.broadcast(result.packet);
        return Response.json({ ok: true, message: result.message });
      }
      if (action?.type === 'unpin_message') {
        const result = await unpinRoomMessage(this.env, meta, action);
        await this.broadcast(result.packet);
        return Response.json({ ok: true, messageId: result.messageId });
      }
      return Response.json(
        { error: { code: 'invalid_request', message: '不支持的消息操作' } },
        { status: 400 }
      );
    } catch (error) {
      if (
        error instanceof MessageSubmissionError ||
        error instanceof MessageDeletionError ||
        error instanceof MessagePinningError
      ) {
        return Response.json(
          { error: { code: error.code || 'invalid_request', message: error.message } },
          { status: error.status || 400 }
        );
      }
      console.error(JSON.stringify({
        message: 'client room action failed',
        roomId: Number(access.room.id),
        error: error instanceof Error ? error.message : String(error)
      }));
      return Response.json(
        { error: { code: 'internal_error', message: '消息操作失败' } },
        { status: 500 }
      );
    }
  }

  async fetch(request) {
    const health = durableObjectHealth(request, 'ChannelRoom');
    if (health) return health;
    const url = new URL(request.url);

    if (url.pathname === '/external-message' && request.method === 'POST') {
      return this.receiveExternalMessage(request);
    }

    if (url.pathname === '/client-action' && request.method === 'POST') {
      return this.receiveClientAction(request);
    }

    // #220 已读回执：内部上报通道（verified internal，同 /client-action 形状）。
    if (url.pathname === '/receipts' && request.method === 'POST') {
      return this.receiveRoomReceipts(request);
    }

    // #220 分层查询快照：GET /receipts/snapshot?roomId=N（verified internal）→ 最新30条聚合已读。
    if (url.pathname === '/receipts/snapshot' && request.method === 'GET') {
      return this.receiveRoomReceiptsSnapshot(request);
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const token = url.searchParams.get('token') || '';
    const kind = url.searchParams.get('kind') || '';
    const roomId = Number(url.searchParams.get('id') || '');

    // #217 认证适配：两种通道都先验模块 JWT（本地验签，零网络）——
    // claims 必须落 meta（按消息重验 + 续期换绑都依赖它，实测 #217：内部通道若不带 claims，首条业务帧即 1008）：
    // ① 内部通道（HTTP 面 middleware 已验签+JIT，头带内部数字 id；do-bridge 同帧透传 ?token=）；
    // ② 直连 ?token=（JWT → verify → jitEnsure → 内部 id）。
    const verified = await verifyAccessToken(this.env, token);
    if (!verified.ok) {
      return new Response('Unauthorized', { status: verified.status });
    }
    let principal = parseVerifiedPrincipal(request);
    if (!principal) {
      const ensured = await jitEnsureUser(this.env.DB, verified.claims);
      if (!ensured.ok) {
        return new Response('Unauthorized', { status: ensured.status });
      }
      principal = {
        userId: ensured.user.id,
        isAdmin: false
      };
    }
    const claims = verified.claims;

    const access = await authorizeRoom(this.env.DB, principal, kind, roomId);

    if (!access.ok) {
      return new Response('Forbidden', { status: 403 });
    }
    const { room } = access;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    const meta = socketMeta(claims, principal, room);
    server.serializeAttachment(meta);
    this.connections.set(server, meta);
    server.send(
      JSON.stringify({
        protocolVersion: 1,
        type: 'ready',
        room: {
          id: Number(room.id),
          kind: room.kind,
          name: room.name
        }
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  // #220 已读回执内部上报（verified internal，同 /client-action 形状）：
  // 成员校验（authorizeRoom）→ 幂等落行（recordReadReceipts）→ 实际新增>0 才聚合广播；
  // 幂等重放=零新增行=零事件（验收锚点）。广播帧形与上游协议同族：
  // {protocolVersion:1, type:'read_receipts', messageId(批内最大), userId, readAt(最新), messageIds:[...]}
  async receiveRoomReceipts(request) {
    if (!isVerifiedInternalRequest(request)) {
      return Response.json(
        { error: { code: 'authentication_required', message: '请先登录' } },
        { status: 401 }
      );
    }

    const principal = parseVerifiedPrincipal(request);
    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json(
        { error: { code: 'invalid_request', message: '参数无效' } },
        { status: 400 }
      );
    }
    const room = payload?.room;
    if (!principal || !room || !Number.isInteger(Number(room?.id))) {
      return Response.json(
        { error: { code: 'invalid_request', message: '参数无效' } },
        { status: 400 }
      );
    }

    const access = await authorizeRoom(this.env.DB, principal, room.kind, Number(room.id));
    if (!access.ok) {
      return Response.json(
        { error: { code: 'forbidden', message: '无权访问该会话' } },
        { status: 403 }
      );
    }

    const messageIds = Array.isArray(payload?.messageIds)
      ? payload.messageIds.map((id) => Number(id))
      : [];
    const newlyRead = await recordReadReceipts(this.env.DB, {
      channelId: access.room.id,
      userId: principal.userId,
      messageIds
    });

    // 聚合广播：实际新增行>0 才发帧；重放/空批零事件。DO 是唯一写者：HTTP 面只转发，
    // 本路由 recordReadReceipts 幂等落行并算 diff——重放同批=零新增=零帧（验收锚点）。
    if (newlyRead.length > 0) {
      const ordered = [...newlyRead].sort((left, right) => left.messageId - right.messageId);
      const last = ordered[ordered.length - 1];
      await this.broadcast(JSON.stringify({
        protocolVersion: 1,
        type: 'read_receipts',
        room: { id: Number(access.room.id), kind: access.room.kind },
        messageId: last.messageId,
        userId: principal.userId,
        readAt: last.readAt,
        messageIds: ordered.map((item) => item.messageId)
      }));
    }
    return Response.json({ ok: true, broadcast: newlyRead.length > 0, receipts: newlyRead });
  }

  /**
   * #220 DO 兜底 SQL（分层查询）：最新 30 条消息各自聚合已读数与已读名单——
   * json_object 键名 userId/readAt 与广播帧/前端帧同形，供「已读 n/m」分页补齐。
   */
  async roomReceiptsSnapshot(roomId) {
    const { results } = await this.env.DB
      .prepare(
        `SELECT m.id,
                (SELECT COUNT(*) FROM read_receipts rr WHERE rr.message_id = m.id) AS read_count,
                (SELECT COALESCE(json_group_array(json_object('userId', rr.user_id, 'readAt', rr.read_at)), '[]')
                 FROM read_receipts rr WHERE rr.message_id = m.id) AS read_by
         FROM messages m
         WHERE m.channel_id = ? AND m.deleted_at IS NULL
         ORDER BY m.id DESC
         LIMIT 30`,
      )
      .bind(Number(roomId))
      .all();
    return results.map((row) => ({
      messageId: Number(row.id),
      readCount: Number(row.read_count || 0),
      readBy: JSON.parse(row.read_by || '[]')
    }));
  }

  /** #220 兜底快照路由（verified internal）：GET /receipts/snapshot?roomId=N。 */
  async receiveRoomReceiptsSnapshot(request) {
    if (!isVerifiedInternalRequest(request)) {
      return Response.json(
        { error: { code: 'authentication_required', message: '请先登录' } },
        { status: 401 }
      );
    }
    const url = new URL(request.url);
    const roomId = Number(url.searchParams.get('roomId') || '');
    if (!Number.isInteger(roomId) || roomId <= 0) {
      return Response.json(
        { error: { code: 'invalid_request', message: '参数无效' } },
        { status: 400 }
      );
    }
    return Response.json({ ok: true, receipts: await this.roomReceiptsSnapshot(roomId) });
  }

  async webSocketMessage(ws, message) {
    const meta = this.connections.get(ws);
    if (!meta) {
      return;
    }

    if (getMessageByteLength(message) > MESSAGE_SIZE_LIMIT) {
      sendSocketError(ws, `消息过大，最大 ${Math.round(MESSAGE_SIZE_LIMIT / 1024)}KB`);
      return;
    }

    const payload = this.parsePayload(ws, normalizeWebSocketMessage(message));
    if (!payload) {
      return;
    }

    // #217 token 续期控制帧：先于一切业务类型判定（决策 #51 定案 C）。
    // 允许当前绑定已过期时刷新（这正是续期场景），但 socket 必须已有 meta（已建连）。
    if (payload.type === 'token_refresh') {
      const nextMeta = await this.refreshSocketToken(ws, meta, payload);
      if (!nextMeta) {
        this.closeUnauthorizedSocket(ws);
      }
      return;
    }

    if (!['send', 'delete_message', 'pin_message', 'unpin_message'].includes(payload.type)) {
      sendSocketError(ws, 'Unsupported message type');
      return;
    }

    try {
      const currentMeta = await this.revalidateConnection(ws, meta);
      if (!currentMeta) {
        return;
      }

      if (payload.type === 'delete_message') {
        const result = await deleteRoomMessage(this.env, currentMeta, payload);
        await this.broadcast(result.packet);
        this.runAttachmentCleanup(result);
        return;
      }
      if (payload.type === 'pin_message') {
        const { packet } = await pinRoomMessage(this.env, currentMeta, payload);
        await this.broadcast(packet);
        return;
      }
      if (payload.type === 'unpin_message') {
        const { packet } = await unpinRoomMessage(this.env, currentMeta, payload);
        await this.broadcast(packet);
        return;
      }

      const { message: saved, packet } = await submitRoomMessage(
        this.env,
        currentMeta,
        payload
      );
      await this.broadcast(packet);
      // 未读与外部桥接都属于提交后投影，异步执行以缩短 WebSocket 发送链路。
      this.runMessageProjections(currentMeta.room, saved);
    } catch (error) {
      if (
        error instanceof MessageSubmissionError ||
        error instanceof MessageDeletionError ||
        error instanceof MessagePinningError
      ) {
        sendSocketError(ws, error.message);
        return;
      }
      console.error(JSON.stringify({
        message: 'room message action failed',
        roomId: Number(meta.room?.id || 0),
        error: error instanceof Error ? error.message : String(error)
      }));
      sendSocketError(ws, '消息操作失败');
    }
  }

  webSocketClose(ws) {
    this.connections.delete(ws);
  }

  webSocketError(ws) {
    this.connections.delete(ws);
  }
}
