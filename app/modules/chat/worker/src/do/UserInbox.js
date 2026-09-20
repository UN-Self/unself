// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/do/UserInbox.js（GPL-3.0-only，裁剪版）
import { isVerifiedInternalRequest, parseVerifiedUserId } from '../verified-identity.js';
import { durableObjectHealth } from '../maintenance/do-health.ts';

export class UserInbox {
  constructor(state) {
    this.state = state;
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

    if (url.pathname === '/connect') {
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

  webSocketClose(ws) {
    this.connections.delete(ws);
  }

  webSocketError(ws) {
    this.connections.delete(ws);
  }
}
