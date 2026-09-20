// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #279：资产 content-type 必须在**上传时**定对（CF 直传契约：part 的类型就是 serving 的类型）。
 *
 * 两层断言，缺一不可：
 *  A) `contentTypeForPath` 纯函数表驱动——扩展名 → 类型（含 `text/*; charset=utf-8` 与兜底）；
 *  B) `uploadMissingAssets` 真的把类型写进 multipart part——变异回写死的 octet-stream 时 B 必红，
 *     把 `.js` 映射改成错值（如 text/html）时 A、B 同红（证明断言按扩展名核对，不是「非 octet 即过」）。
 *
 * 为什么测行为而不是测源码：白屏的教训是「HTTP/curl 全绿」，唯一能守住的是
 * 「发给 CF 的每个 part 的类型」与「serving 回来的类型」两处都对得上。
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FALLBACK_CONTENT_TYPE, contentTypeForPath, knownMimeExtensions } from '../../src/engine/rest/mime';
import { assetHash, buildAssetManifest, startAssetSession, uploadMissingAssets } from '../../src/engine/rest/assets';
import { RestClient } from '../../src/engine/rest/client';

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

async function makeAssetsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'unself-279-'));
  temps.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

describe('#279 A) contentTypeForPath：扩展名 → Content-Type（表驱动）', () => {
  const cases: Array<[string, string]> = [
    ['/index.html', 'text/html; charset=utf-8'],
    ['/setup/index.htm', 'text/html; charset=utf-8'],
    ['/assets/index-8Fx6QgQW.js', 'text/javascript; charset=utf-8'],
    ['/assets/module.mjs', 'text/javascript; charset=utf-8'],
    ['/assets/index-ByHH0PGS.css', 'text/css; charset=utf-8'],
    ['/assets/manifest.webmanifest', 'application/manifest+json'],
    ['/data/registry.json', 'application/json'],
    ['/assets/app.js.map', 'application/json'],
    ['/logo.svg', 'image/svg+xml'],
    ['/fonts/inter-latin.woff2', 'font/woff2'],
    ['/fonts/inter-latin.woff', 'font/woff'],
    ['/img/shot.png', 'image/png'],
    ['/img/shot.jpg', 'image/jpeg'],
    ['/img/shot.webp', 'image/webp'],
    ['/img/shot.avif', 'image/avif'],
    ['/favicon.ico', 'image/vnd.microsoft.icon'],
    ['/robots.txt', 'text/plain; charset=utf-8'],
    ['/sdk/module-sdk.wasm', 'application/wasm'],
  ];
  for (const [path, expected] of cases) {
    it(`${path} → ${expected}`, () => {
      expect(contentTypeForPath(path)).toBe(expected);
    });
  }

  it('大小写不敏感（.JS 与 .js 同类型）', () => {
    expect(contentTypeForPath('/assets/index.JS')).toBe('text/javascript; charset=utf-8');
  });

  it('只认 basename 的扩展名（目录名带点不误导）', () => {
    expect(contentTypeForPath('/a.b/assets/index-abc')).toBe(FALLBACK_CONTENT_TYPE);
  });

  it('未知扩展名 → 兜底 octet-stream（且兜底不是任何已知扩展名的路径）', () => {
    expect(contentTypeForPath('/blob.unknownext')).toBe(FALLBACK_CONTENT_TYPE);
    expect(contentTypeForPath('/no-extension')).toBe(FALLBACK_CONTENT_TYPE);
    // 关键不变式：表内**没有**任何扩展名映射到 octet-stream —— 它只作兜底
    for (const ext of knownMimeExtensions()) {
      expect(contentTypeForPath(`/x.${ext}`), `.${ext} 不该走兜底`).not.toBe(FALLBACK_CONTENT_TYPE);
    }
  });

  it('HTML 不是 octet-stream（白屏根因的直接断言）', () => {
    expect(contentTypeForPath('/index.html')).not.toBe(FALLBACK_CONTENT_TYPE);
    expect(contentTypeForPath('/assets/index-abc.js')).not.toBe(FALLBACK_CONTENT_TYPE);
    expect(contentTypeForPath('/assets/index-abc.css')).not.toBe(FALLBACK_CONTENT_TYPE);
  });
});

describe('#279 C) assetHash 掺入 content-type（存量实例可修复的机制）', () => {
  const require_ = createRequire(import.meta.url);
  const blake3 = require_('blake3-wasm') as { hash(input: string): { toString(enc: string): string } };

  it('hash = blake3(base64 + ext + NUL + 类型) 前 32 位 hex（独立复算，防公式漂移）', async () => {
    const dir = await makeAssetsDir({ 'index.html': '<!doctype html><p>x</p>' });
    const abs = join(dir, 'index.html');
    const base64 = readFileSync(abs).toString('base64');
    const expected = blake3.hash(`${base64}html\u0000text/html; charset=utf-8`).toString('hex').slice(0, 32);
    expect(assetHash(abs)).toBe(expected);
    expect(assetHash(abs)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('不是 wrangler 的 blake3(base64+ext)：类型真的进了哈希 key（#279 修复存量实例的前提）', async () => {
    const dir = await makeAssetsDir({ 'index.html': '<!doctype html><p>x</p>' });
    const abs = join(dir, 'index.html');
    const base64 = readFileSync(abs).toString('base64');
    const wranglerStyle = blake3.hash(base64 + 'html').toString('hex').slice(0, 32);
    expect(assetHash(abs)).not.toBe(wranglerStyle);
  });
});

describe('#279 B) uploadMissingAssets：multipart 每个 part 的 Content-Type 按扩展名', () => {
  /** 捕获上传 FormData 的 REST 替身（会话端点返回全部哈希为缺失，走上传分支）。 */
  function capture(): { client: RestClient; parts: () => Array<{ name: string; type: string }> } {
    const captured: Array<{ name: string; type: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/assets-upload-session')) {
        const manifest = (JSON.parse(String(init!.body)) as { manifest: Record<string, { hash: string }> }).manifest;
        const hashes = Object.values(manifest).map((e) => e.hash);
        return Response.json({ result: { jwt: 'session-jwt', buckets: hashes.map((h) => [h]) } });
      }
      if (href.includes('/workers/assets/upload')) {
        const form = init!.body as FormData;
        for (const [name, value] of form.entries()) {
          captured.push({ name: String(name), type: (value as Blob).type });
        }
        return Response.json({ result: { jwt: 'completion-jwt' } });
      }
      throw new Error(`替身未覆盖的端点：${href}`);
    }) as typeof fetch;
    return {
      client: { fetchImpl, token: 'tok' } as unknown as RestClient,
      parts: () => captured,
    };
  }

  it('html/js/css/svg/woff2/png 各自拿到正确类型；未知扩展名才落 octet-stream', async () => {
    const dir = await makeAssetsDir({
      'index.html': '<!doctype html><html></html>',
      'assets/index-abc.js': 'export const x = 1;\n',
      'assets/index-abc.css': 'body{margin:0}\n',
      'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'fonts/inter.woff2': 'wOF2-fake',
      'img/shot.png': 'PNG-fake',
      'data/payload.unknownext': 'mystery',
    });
    const manifest = buildAssetManifest(dir);
    const { client, parts } = capture();
    const session = await startAssetSession(client, 'acct', 'probe-279', manifest);
    await uploadMissingAssets(client, 'acct', session, manifest, dir);

    const hashToType = new Map(parts().map((p) => [p.name, p.type]));
    const typeOf = (path: string): string | undefined => hashToType.get(manifest[path]!.hash);

    expect(typeOf('/index.html')).toBe('text/html; charset=utf-8');
    expect(typeOf('/assets/index-abc.js')).toBe('text/javascript; charset=utf-8');
    expect(typeOf('/assets/index-abc.css')).toBe('text/css; charset=utf-8');
    expect(typeOf('/logo.svg')).toBe('image/svg+xml');
    expect(typeOf('/fonts/inter.woff2')).toBe('font/woff2');
    expect(typeOf('/img/shot.png')).toBe('image/png');
    expect(typeOf('/data/payload.unknownext')).toBe(FALLBACK_CONTENT_TYPE);

    // 上传覆盖了全部文件（没漏 part）且没有「已知扩展名落 octet-stream」
    expect(hashToType.size).toBe(Object.keys(manifest).length);
    for (const path of ['/index.html', '/assets/index-abc.js', '/assets/index-abc.css', '/logo.svg']) {
      expect(typeOf(path), `${path} 不该是 octet-stream`).not.toBe(FALLBACK_CONTENT_TYPE);
    }
  });
});
