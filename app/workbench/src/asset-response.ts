// SPDX-License-Identifier: AGPL-3.0-only
/** 修复已知壳页面与构建资产的旧 MIME；未知文件与失败响应保持原样。 */
export function normalizeAssetResponse(response: Response, pathname: string): Response {
  if (response.status !== 200) return response;
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type && type !== 'application/octet-stream') return response;
  let contentType: string | undefined;
  if (/\.(?:m?js)$/i.test(pathname)) contentType = 'text/javascript; charset=utf-8';
  else if (/\.css$/i.test(pathname)) contentType = 'text/css; charset=utf-8';
  else if (/^(?:\/|\/index\.html|\/setup\/?|\/login\/?|\/app-password\/?|\/admin(?:\/.*)?|\/(?:invite|activate)\/[^/]+)$/.test(pathname)) {
    contentType = 'text/html; charset=utf-8';
  }
  if (!contentType) return response;
  const headers = new Headers(response.headers);
  headers.set('content-type', contentType);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
