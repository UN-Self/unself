// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 静态资产直传（#65）：manifest（blake3 前 10 字节 urlsafe）→ assets-upload-session →
 * 桶式批量上传（base64 form）→ completion JWT → 部署 metadata.assets.jwt。
 * 哈希/端点形状实测（wrangler 4.129.0 hash.ts/assets.ts + 2026-09-17 真机探针）。
 * blake3 取自 wrangler 同款 wasm（blake3-wasm 依赖，仅 devDependency 级体积）。
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { RestClient } from './client';

export interface AssetManifestEntry {
  hash: string;
  size: number;
}

export type AssetManifest = Record<string, AssetManifestEntry>;

/** wrangler hashFile 同款：blake3(base64(content) + ext) hex 前 32 位截断为 10 字节 urlsafe。 */
export function assetHash(absPath: string): string {
  const content = readFileSync(absPath);
  const base64 = content.toString('base64');
  const ext = extname(absPath).slice(1);
  // wrangler hash.ts 同款：blake3 hex 前 32 位（16 字节），无 urlsafe 转换（hex 天然安全）
  return blake3Hash(base64 + ext).slice(0, 32);
}

function extname(p: string): string {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i);
}

/** blake3（与 wrangler 4.129.0 hash.ts 同款）：blake3-wasm（wrangler 已有传递依赖，本仓提升可解析）。 */
function blake3Hash(input: string): string {
  const blake3 = createRequire(import.meta.url)('blake3-wasm') as {
    hash(input: string): { toString(enc: string): string };
  };
  return blake3.hash(input).toString('hex');
}

/** 目录 → manifest（递归；key 为 / 开头的 posix 路径——CF manifest 契约）。 */
export function buildAssetManifest(dir: string): AssetManifest {
  const manifest: AssetManifest = {};
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs)) walk(rel ? posix.join(rel, entry) : entry);
      return;
    }
    manifest[`/${rel.replaceAll('\\', '/')}`] = { hash: assetHash(abs), size: st.size };
  };
  for (const entry of readdirSync(dir)) walk(entry);
  return manifest;
}

export interface AssetUploadSession {
  jwt: string;
  buckets: string[][];
}

export async function startAssetSession(
  client: { fetchImpl: typeof fetch; readonly token?: string },
  accountId: string,
  scriptName: string,
  manifest: AssetManifest,
): Promise<AssetUploadSession> {
  // wrangler fetchResult 同款：POST 信封请求（带 Bearer），响应 result = {jwt, buckets}。
  // 2026-09-18 真机复核：无 Authorization → 9106（此端点不吃会话外匿名）；信封内 result 为会话对象。
  const res = await client.fetchImpl(`${'https://api.cloudflare.com/client/v4'}/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(client.token ? { Authorization: `Bearer ${client.token}` } : {}),
    },
    body: JSON.stringify({ manifest }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  const session = (json?.result ?? json) as AssetUploadSession | undefined;
  if (!res.ok || !session?.jwt) {
    throw new Error(`资产会话创建失败：HTTP ${res.status} ${JSON.stringify(json).slice(0, 600)}`);
  }
  return session;
}

/** 批量上传缺失文件（base64 form，字段=哈希）；返回 completion JWT。 */
export async function uploadMissingAssets(
  client: RestClient,
  accountId: string,
  session: AssetUploadSession,
  manifest: AssetManifest,
  dir: string,
): Promise<string> {
  const byHash = new Map<string, string>();
  for (const [path, entry] of Object.entries(manifest)) byHash.set(entry.hash, path);
  const missing = session.buckets.flat().filter((hash) => byHash.has(hash));
  if (missing.length === 0) {
    if (!session.jwt) throw new Error('资产会话未返回 completion token');
    return session.jwt;
  }
  const form = new FormData();
  for (const hash of missing) {
    const abs = join(dir, byHash.get(hash)!);
    form.append(hash, new Blob([readFileSync(abs).toString('base64')], { type: 'application/octet-stream' }), hash);
  }
  const res = await client.fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/assets/upload?base64=true`,
    {
      method: 'POST',
      // 资产上传授权 = 会话 jwt（非账户 token，wrangler 同款）
      headers: { Authorization: `Bearer ${session.jwt}` },
      body: form,
    },
  );
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  // 响应形状：信封（result.jwt）与裸 {jwt} 都见过——兼容两者（2026-09-18 真机：HTTP 201 信封）。
  const jwt = json?.jwt ?? json?.result?.jwt;
  if (!res.ok || !jwt) {
    throw new Error(`资产上传失败：HTTP ${res.status} body=${text.slice(0, 400)}`);
  }
  return jwt;
}
