// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/maintenance/do-health.ts（GPL-3.0-only，裁剪版）
import { isVerifiedInternalRequest } from '../verified-identity.js';

export function durableObjectHealth(request: Request, service: string): Response | null {
  if (new URL(request.url).pathname !== '/health') return null;
  if (!isVerifiedInternalRequest(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  }
  // 健康请求只证明对象代码可达；不接收连接、不读写业务状态、更不启动 alarm。
  return Response.json({ ok: true, service });
}
