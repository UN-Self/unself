// SPDX-License-Identifier: AGPL-3.0-only

/** Cloudflare 原生探活响应不会唤醒休眠中的 DO；其他运行时沿用消息处理器。 */
export function configureHeartbeat(state) {
  if (typeof state.setWebSocketAutoResponse !== 'function'
      || typeof WebSocketRequestResponsePair === 'undefined') return;
  state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(
    JSON.stringify({ protocolVersion: 1, type: 'ping' }),
    JSON.stringify({ protocolVersion: 1, type: 'pong' }),
  ));
}
