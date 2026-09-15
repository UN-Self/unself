// SPDX-License-Identifier: AGPL-3.0-only

/**
 * worker 源码（JS）在 TS 测试侧的最小类型面：
 * checkJs=false 下 JS 推断丢失类型信息；且 chat 的默认导出是
 * `{ fetch: app.fetch, scheduled }`（workers-module 形状），不是裸 Hono 实例。
 * 这里包一层 request()：Request 构造 + worker.fetch(request, env)，
 * 与 Hono 的 app.request(input, init, env) 调用形状一致，测试侧不改写法。
 */
import worker from '../worker/src/index.js';

interface WorkerExport {
  fetch(request: Request, env?: unknown, ctx?: unknown): Promise<Response> | Response;
}

const workerExport = worker as unknown as WorkerExport;

/**
 * 复用同一个 env 对象：worker 源码有多处 env 快照（中间件闭包）与状态回写
 * （如 session 刷新后 putSession），跨请求换 env 会丢这些可见效果；
 * 测试内通过 setEnv() 显式换库/换会话存储。
 */
let currentEnv: unknown = {};

export function setEnv(env: unknown): void {
  currentEnv = env;
}

export const app = {
  request(input: string | Request, init?: RequestInit, env?: unknown): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    if (env !== undefined) {
      currentEnv = env;
    }
    return Promise.resolve(workerExport.fetch(request, currentEnv));
  },
};
