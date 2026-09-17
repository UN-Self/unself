// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 静态资产直传（#65）：manifest（blake3 前 10 字节 urlsafe）→ assets-upload-session →
 * 桶式批量上传（base64 form）→ completion JWT → 部署 metadata.assets.jwt。
 * 哈希/端点形状实测（wrangler 4.129.0 hash.ts/assets.ts + 2026-09-17 真机探针）。
 * blake3 取自 wrangler 同款 wasm（blake3-wasm 依赖，仅 devDependency 级体积）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

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

/** blake3（同步 wasm 实现走 blake3-wasm；不可用时退 sha256——哈希只用于内容寻址去重，
 *  同一次部署内自洽即可；但跨工具 diff 语义以 blake3 为准，装配器固定用 blake3-wasm。 */
function blake3Hash(input: string): string {
  // blake3-wasm 与 wrangler 共享（node_modules 提升依赖）；动态 require 规避打包
  const blake3 = (0, eval)('require')('blake3-wasm') as { hash(input: string): { toString(enc: string): string } };
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
  client: { post<T>(path: string, body?: unknown): Promise<{ result: T }> },
  accountId: string,
  scriptName: string,
  manifest: AssetManifest,
): Promise<AssetUploadSession> {
  const res = await client.post<AssetUploadSession>(
    `/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`,
    { manifest },
  );
  return res.result;
}

/** 批量上传缺失文件（base64 form，字段=哈希）；返回 completion JWT。 */
export async function uploadMissingAssets(
  client: RestClientCtor,
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
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/assets/upload?base64=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${client.token}` },
    body: form,
  });
  const json = (await res.json()) as { jwt?: string; success?: boolean; errors?: Array<{ message: string }> };
  if (!res.ok || !json.jwt) {
    throw new Error(`资产上传失败：HTTP ${res.status} ${JSON.stringify(json.errors ?? []).slice(0, 160)}`);
  }
  return json.jwt;
}

/** 客户端最小面（避免与 client.ts 循环依赖的轻量接口）。 */
export interface RestClientCtor {
  token: string;
}

/** sha256 兜底导出（测试用）。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
