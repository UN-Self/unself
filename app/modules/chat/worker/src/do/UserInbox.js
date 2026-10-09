// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/do/UserInbox.js（GPL-3.0-only，裁剪版）
import { isVerifiedInternalRequest, parseVerifiedPrincipal } from '../verified-identity.js';
import { durableObjectHealth } from '../maintenance/do-health.ts';
import { configureHeartbeat } from './heartbeat.js';
import { verifyAccessToken } from '../core-auth.js';
import { jitResolveUser } from '../jit-users.js';
import { wrapEnv } from '../unself-env.js';

export class UserInbox {
  constructor(state, env) {
    this.state = state;
    this.env = wrapEnv(env || {});
    configureHeartbeat(state);
    this.connections = new Map();

    for (const socket of this.state.getWebSockets()) {
      const meta = socket.deserializeAttachment();
      if (meta) this.connections.set(socket, meta);
    }
  }

  async fetch(request) {
    const health = durableObjectHealth(request, 'UserInbox');
    if (health) return health;
    const url = new URL(request.url);

    // 直连部署会把浏览器原始路径直接转发到 DO；本地/旧内部调用仍使用 /connect。
    if (url.pathname === '/connect' || url.pathname === '/api/inbox/ws') {
      const principal = parseVerifiedPrincipal(request);
      const token = url.searchParams.get('token') || '';
      const verified = await verifyAccessToken(this.env, token);
      const ensured = verified.ok ? await jitResolveUser(this.env.DB, verified.claims) : null;
      if (!principal || !verified.ok || !ensured?.ok || ensured.user.id !== principal.userId) {
        return new Response('Unauthorized', { status: 401 });
      }

      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      const meta = { userId: principal.userId, claims: verified.claims };
      server.serializeAttachment(meta);
      this.connections.set(server, meta);
      server.send(JSON.stringify({ protocolVersion: 1, type: 'ready' }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/notify' && request.method === 'POST') {
      if (!isVerifiedInternalRequest(request)) {
        return new Response('Unauthorized', { status: 401 });
      }

      const payload = await request.json();
      await this.broadcast(JSON.stringify(payload));
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
        return;
      }
      const meta = this.connections.get(ws);
      if (!meta) return;
      if (payload?.type === 'token_refresh') {
        void this.refreshSocketToken(ws, meta, payload);
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

  async refreshSocketToken(ws, meta, payload) {
    const token = typeof payload?.token === 'string' ? payload.token : '';
    const verified = await verifyAccessToken(this.env, token);
    const ensured = verified.ok ? await jitResolveUser(this.env.DB, verified.claims) : null;
    if (!verified.ok || !ensured?.ok || ensured.user.id !== meta.userId) {
      this.connections.delete(ws);
      try { ws.close(1008, 'Unauthorized'); } catch { /* stale socket */ }
      return;
    }
    const nextMeta = { userId: meta.userId, claims: verified.claims };
    this.connections.set(ws, nextMeta);
    ws.serializeAttachment(nextMeta);
    ws.send(JSON.stringify({ protocolVersion: 1, type: 'token_refreshed' }));
  }

  async revalidateConnection(ws, meta) {
    const exp = Number(meta?.claims?.exp);
    if (!meta?.claims || !Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;
    const ensured = await jitResolveUser(this.env.DB, meta.claims);
    return ensured.ok && ensured.user.id === meta.userId;
  }

  async broadcast(packet) {
    const sockets = [...this.connections.entries()];
    const checked = await Promise.all(sockets.map(async ([socket, meta]) => ({ socket, valid: await this.revalidateConnection(socket, meta) })));
    for (const { socket, valid } of checked) {
      if (!valid) {
        this.connections.delete(socket);
        try { socket.close(1008, 'Unauthorized'); } catch { /* stale socket */ }
        continue;
      }
      try { socket.send(packet); } catch { this.connections.delete(socket); }
    }
  }
}
