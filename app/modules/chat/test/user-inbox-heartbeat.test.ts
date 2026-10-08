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
});
