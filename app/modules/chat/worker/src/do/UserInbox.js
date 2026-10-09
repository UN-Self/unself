// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/do/UserInbox.js（GPL-3.0-only，裁剪版）
import { isVerifiedInternalRequest, parseVerifiedUserId } from '../verified-identity.js';
import { durableObjectHealth } from '../maintenance/do-health.ts';
import { configureHeartbeat } from './heartbeat.js';

export class UserInbox {
  constructor(state) {
    this.state = state;
    configureHeartbeat(state);
    this.connections = new Set();

    for (const socket of this.state.getWebSockets()) {
      this.connections.add(socket);
    }
  }

  broadcast(packet) {
    for (const socket of this.connections) {
      try {
        socket.send(packet);
      } catch {
        this.connections.delete(socket);
      }
    }
  }

  async fetch(request) {
    const health = durableObjectHealth(request, 'UserInbox');
    if (health) return health;
    const url = new URL(request.url);

    // 直连部署会把浏览器原始路径直接转发到 DO；本地/旧内部调用仍使用 /connect。
    if (url.pathname === '/connect' || url.pathname === '/api/inbox/ws') {
      const userId = parseVerifiedUserId(request);
      if (!userId) {
        return new Response('Unauthorized', { status: 401 });
      }

      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ userId });
      this.connections.add(server);
      server.send(JSON.stringify({ protocolVersion: 1, type: 'ready' }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/notify' && request.method === 'POST') {
      if (!isVerifiedInternalRequest(request)) {
        return new Response('Unauthorized', { status: 401 });
      }

      const payload = await request.json();
      this.broadcast(JSON.stringify(payload));
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    try {
      const payload = JSON.parse(message);
      if (payload?.type === 'ping') {
        ws.send(JSON.stringify({ protocolVersion: 1, type: 'pong' }));
      }
    } catch {
      // 收件箱只处理探活帧；未知或损坏的客户端帧静默丢弃。
    }
  }

  webSocketClose(ws) {
    this.connections.delete(ws);
  }

  webSocketError(ws) {
    this.connections.delete(ws);
  }
}
