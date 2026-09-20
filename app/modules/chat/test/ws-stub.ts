// SPDX-License-Identifier: AGPL-3.0-only

/**
 * #217 WS 行为测试的最小 socket 替身（替 workers 运行时面，不替业务）：
 * - serializeAttachment/deserializeAttachment 走内存 Map（对齐真 socket 语义：附件随 socket 存取）；
 * - send/close 记录到 sent/closed，供断言 ready 帧、ack 帧、1008 关闭码；
 * - 测试里直接驱动 room.webSocketMessage(server, frame) 验证每类帧的行为。
 */
export class FakeWebSocketStub {
  sent: string[];
  closed: Array<{ code: number; reason: string }>;
  attachments: Map<string, unknown>;
  accepted = false;

  constructor() {
    this.sent = [];
    this.closed = [];
    this.attachments = new Map();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.closed.push({ code, reason });
  }

  serializeAttachment(data: unknown): void {
    this.attachments.set('meta', data);
  }

  deserializeAttachment(): unknown {
    return this.attachments.get('meta') ?? null;
  }
}

/** DO state 替身：acceptWebSocket 记录被接受的 server socket（供构造函数重挂连接用）。 */
export class FakeDoState {
  accepted: FakeWebSocketStub[] = [];

  storage = {
    async get(_key: string) {
      return undefined;
    },
    async set(_key: string, _value: unknown) {},
    async delete(_key: string) {},
    async getAlarm() {
      return undefined as number | undefined;
    },
    async setAlarm(_time: number) {},
    async list() {
      return new Map<string, unknown>();
    },
  };

  waitUntil(_promise: Promise<unknown>): void {}

  getWebSockets(): FakeWebSocketStub[] {
    return this.accepted;
  }

  acceptWebSocket(socket: FakeWebSocketStub): void {
    socket.accepted = true;
    this.accepted.push(socket);
  }
}

/** 解析收到的 JSON 帧序列。 */
export function sentFrames(socket: FakeWebSocketStub): Array<Record<string, unknown>> {
  return socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

/** 最近一次关闭（未关则 undefined）。 */
export function lastClose(socket: FakeWebSocketStub): { code: number; reason: string } | undefined {
  return socket.closed.at(-1);
}

interface WsPairCtor {
  new (): { client: unknown; server: FakeWebSocketStub };
}

/**
 * WS 测试运行时垫片（测试套件模块级安装）：
 * ① WebSocketPair 的 server 侧换 FakeWebSocketStub——真 workers 会把 pair.server 接进 DO
 *    事件回调，Node 测试环境没有该接线，替身让 server.send/serializeAttachment 可观察、
 *    可被 FakeDoState.acceptWebSocket 收编；
 * ② Response 对 101 + webSocket 形状放行（Node 的 Response 构造器拒绝 101 状态码），
 *    其余形状原样透传真 Response——业务代码零改动。
 */
export function installWebSocketTestShim(): () => void {
  const globalScope = globalThis as unknown as {
    Response: typeof Response;
    WebSocketPair?: WsPairCtor;
  };
  const RealResponse = globalScope.Response;
  const RealWebSocketPair = globalScope.WebSocketPair;

  globalScope.WebSocketPair = class {
    client: unknown;
    server: FakeWebSocketStub;

    constructor() {
      this.client = { __fakeClient: true };
      this.server = new FakeWebSocketStub();
    }
  } as WsPairCtor;

  const PatchedResponse = function (body: BodyInit | null, init?: ResponseInit) {
    if (init?.status === 101 && 'webSocket' in init) {
      // workers 语义：101 + 客户端 socket；替身回可断言的普通对象（ChannelRoom 只读 status）。
      return {
        status: 101,
        webSocket: (init as { webSocket: unknown }).webSocket,
        headers: new Headers(),
      } as unknown as Response;
    }
    return new RealResponse(body, init);
  } as unknown as typeof Response;
  Object.setPrototypeOf(PatchedResponse, RealResponse);
  Object.setPrototypeOf(PatchedResponse.prototype, RealResponse.prototype);

  globalScope.Response = PatchedResponse;
  return () => {
    globalScope.Response = RealResponse;
    globalScope.WebSocketPair = RealWebSocketPair;
  };
}
