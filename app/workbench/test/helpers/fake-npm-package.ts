// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 假 npm 源（测试用，#349）：一条 fetch 实现同时扮演 registry 元数据 / tarball / CF 上传。
 * 与 app/workbench/test/runtime-install.test.ts 里的构造同源，抽出来给路由级测试复用。
 */

function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name).subarray(0, 100), 0);
  header.set(enc.encode('0000644\0'), 100);
  header.set(enc.encode('0000000\0'), 108);
  header.set(enc.encode('0000000\0'), 116);
  header.set(enc.encode(size.toString(8).padStart(11, '0') + '\0'), 124);
  header.set(enc.encode('00000000000\0'), 136);
  header[156] = '0'.charCodeAt(0);
  header.set(enc.encode('ustar\0'), 257);
  header.set(enc.encode('00'), 263);
  return header;
}

export function buildTar(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = enc.encode(content);
    chunks.push(tarHeader(name, bytes.byteLength), bytes);
    const pad = (512 - (bytes.byteLength % 512)) % 512;
    if (pad > 0) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 假 npm + CF 源；调用记录里 auth 只有 CF 上传那一跳有值。 */
export function stubNpmFetch(pkgFiles: Record<string, string>, opts?: { cfStatus?: number }) {
  const calls: Array<{ url: string; method: string; auth?: string }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    const headers = new Headers(init?.headers as Record<string, string> | undefined);
    calls.push({ url: target, method: init?.method ?? 'GET', auth: headers.get('authorization') ?? undefined });
    if (target.endsWith('.tgz')) {
      return new Response(await gzip(buildTar(pkgFiles)));
    }
    if (target.includes('registry.npmjs.org')) {
      return Response.json({
        'dist-tags': { latest: '1.2.3' },
        versions: { '1.2.3': { dist: { tarball: 'https://registry.npmjs.org/x/-/x-1.2.3.tgz' } } },
      });
    }
    if (target.includes('api.cloudflare.com')) {
      const status = opts?.cfStatus ?? 200;
      return Response.json(status === 200 ? { success: true, result: {} } : { success: false, errors: [{ message: 'auth denied' }] }, {
        status,
      });
    }
    return new Response('not found', { status: 404 });
  };
  return { impl: impl as typeof fetch, calls };
}
