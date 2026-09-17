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
  const digest = blake3Hash(base64 + ext);
  return urlSafe(digest).slice(0, 10);
}

function extname(p: string): string {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i);
}

function urlSafe(s: string): string {
  return s.replaceAll('+', '-').replaceAll('/', '_');
}

/** blake3（与 wrangler 4.129.0 hash.ts 同款）：blake3-wasm（wrangler 已有传递依赖，本仓提升可解析）。 */
function blake3Hash(input: string): string {
  const blake3 = createRequire(import.meta.url)('blake3-wasm') as {
    hash(input: string): { toString(enc: string): string };
  };
  return blake3.hash(input).toString('hex');
}

/** 目录 → manifest（递归；key 为 posix 相对路径）。 */
export function buildAssetManifest(dir: string): AssetManifest {
  const manifest: AssetManifest = {};
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs)) walk(rel ? posix.join(rel, entry) : entry);
      return;
    }
    manifest[rel.replaceAll('\\', '/')] = { hash: assetHash(abs), size: st.size };
  };
  for (const entry of readdirSync(dir)) walk(entry);
  return manifest;
}

export interface AssetUploadSession {
  jwt: string;
  buckets: string[][];
}

export async function startAssetSession(
  client: { fetchImpl: typeof fetch },
  accountId: string,
  scriptName: string,
  manifest: AssetManifest,
): Promise<AssetUploadSession> {
  // 会话端点为裸响应（{jwt, buckets}，非 CF 信封——2026-09-17 真机探针实测）
  const res = await client.fetchImpl(`${'https://api.cloudflare.com/client/v4'}/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  const json = (await res.json()) as AssetUploadSession & { errors?: Array<{ message: string }> };
  if (!res.ok || !json.jwt) {
    throw new Error(`资产会话创建失败：HTTP ${res.status}`);
  }
  return json;
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
  const json = (await res.json()) as { jwt?: string; success?: boolean; errors?: Array<{ message: string }> };
  if (!res.ok || !json.jwt) {
    throw new Error(`资产上传失败：HTTP ${res.status} ${JSON.stringify(json.errors ?? []).slice(0, 160)}`);
  }
  return json.jwt;
}
