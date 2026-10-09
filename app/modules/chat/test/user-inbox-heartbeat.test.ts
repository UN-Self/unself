// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { UserInbox } from '../worker/src/do/UserInbox.js';
import { FakeDoState, FakeWebSocketStub, sentFrames } from './ws-stub';

describe('UserInbox heartbeat', () => {
  it('应用层 ping → pong', () => {
    const inbox = new UserInbox(new FakeDoState() as never);
    const socket = new FakeWebSocketStub();

    inbox.webSocketMessage(socket, JSON.stringify({ protocolVersion: 1, type: 'ping' }));

    expect(sentFrames(socket)).toEqual([{ protocolVersion: 1, type: 'pong' }]);
  });

  it('收件箱通知不会投递给已过期的连接', async () => {
    const inbox = new UserInbox(new FakeDoState() as never);
    const socket = new FakeWebSocketStub();
    ;(inbox as unknown as { connections: Map<unknown, unknown> }).connections.set(socket, {
      userId: 1,
      claims: { exp: Math.floor(Date.now() / 1000) - 1 },
    });

    const response = await inbox.fetch(new Request('https://chat.example/notify', {
      method: 'POST',
      headers: { 'x-cfchat-internal-auth': 'worker-verified', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'room_message' }),
    }));

    expect(response.status).toBe(200);
    expect(sentFrames(socket)).toEqual([]);
    expect(socket.closed).toEqual([{ code: 1008, reason: 'Unauthorized' }]);
  });
});
