// SPDX-License-Identifier: AGPL-3.0-only
const MAX_BYTES = 2 * 1024 * 1024;

/** 有界读取：不信 Content-Length，也不把无限请求体全读进内存。 */
export async function readAvatar(request: Request): Promise<{ bytes: ArrayBuffer; contentType: string } | { error: string; status: 400 | 413 }> {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return { error: '头像不能超过 2 MB', status: 413 };
  const reader = request.body?.getReader();
  if (!reader) return { error: '请选择图片', status: 400 };
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BYTES) {
        await reader.cancel();
        return { error: '头像不能超过 2 MB', status: 413 };
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const matches = (values: number[], start = 0) => values.every((v, i) => bytes[start + i] === v);
  let contentType = '';
  if (length >= 24 && matches([137, 80, 78, 71, 13, 10, 26, 10])) contentType = 'image/png';
  else if (length >= 4 && matches([255, 216, 255])) contentType = 'image/jpeg';
  else if (length >= 16 && matches([82, 73, 70, 70]) && matches([87, 69, 66, 80], 8)) contentType = 'image/webp';
  if (!contentType || request.headers.get('content-type')?.split(';')[0] !== contentType) {
    return { error: '请选择 PNG、JPEG 或 WebP 图片', status: 400 };
  }
  return { bytes: bytes.buffer, contentType };
}
