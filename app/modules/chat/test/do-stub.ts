// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 最小 DO 运行时替身（tests/：仅替外部运行时，不替业务）：
 * ChannelRoom 真类 + 单实例容器（wrangler dev 里同 idFromName 也复用同一实例，
 * 语义一致）。只替 workers 运行时面（state/getWebSockets/waitUntil），
 * 业务 SQL/加密/权限全部走真库与真实现。
 */
import { ChannelRoom } from '../worker/src/do/ChannelRoom.js';
import { UserInbox } from '../worker/src/do/UserInbox.js';

type DoState = {
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    getAlarm(): Promise<number | undefined>;
    setAlarm(time: number): Promise<void>;
    list(): Promise<Map<string, unknown>>;
  };
  waitUntil(promise: Promise<unknown>): void;
  getWebSockets(): unknown[];
  acceptWebSocket(socket: unknown): void;
};

function makeDoState(): DoState {
  return {
    storage: {
      async get() {
        return undefined;
      },
      async set() {},
      async delete() {},
      async getAlarm() {
        return undefined;
      },
      async setAlarm() {},
      async list() {
        return new Map();
      },
    },
    waitUntil() {},
    getWebSockets: () => [],
    acceptWebSocket() {},
  };
}

/** 运行时等价转换：真实 workers 会把 stub.fetch(string) 转成 Request，这里补上同样语义。 */
function toRequest(input: string | Request, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}

/** 单实例容器：同 env 内复用同一 DO 实例（保持 connections 状态），语义与 wrangler dev 一致。 */
export function installRoomDo(env: Record<string, unknown>): void {
  const room = new ChannelRoom(makeDoState(), env);
  env.CHANNEL_ROOM = {
    idFromName: (_name: string) => 'room',
    get: () => ({
      fetch: (input: string | Request, init?: RequestInit) => room.fetch(toRequest(input, init)),
    }),
  };

  const inbox = new UserInbox(makeDoState());
  env.USER_INBOX = {
    idFromName: (_name: string) => 'inbox',
    get: () => ({
      fetch: (input: string | Request, init?: RequestInit) => inbox.fetch(toRequest(input, init)),
    }),
  };
}
