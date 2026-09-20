// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 静态资产直传（#65）：manifest（blake3(base64+ext+类型) 前 32 位 hex，见 `assetHash`）→ assets-upload-session →
 * 桶式批量上传（base64 form，part 类型按扩展名，见 `mime.ts`）→ completion JWT → 部署 metadata.assets.jwt。
 * 哈希/端点形状实测（wrangler 4.129.0 hash.ts/assets.ts + 2026-09-17/#279 真机探针）。
 * blake3 取自 wrangler 同款 wasm（blake3-wasm 依赖，仅 devDependency 级体积）。
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { RestClient } from './client';
import { contentTypeForPath } from './mime';

export interface AssetManifestEntry {
  hash: string;
  size: number;
}

export type AssetManifest = Record<string, AssetManifestEntry>;

/**
 * 资产哈希（manifest 的 key）：`blake3(base64(content) + ext + "\0" + contentType)` 前 32 位 hex。
 *
 * **为什么必须掺 content-type**（#279 真机实证，2026-09-18；wrangler 4.129.1 / CF REST v4 / Node v26.8.2）：
 * CF 直传把**上传时 multipart part 的 Content-Type 按哈希记下**，而 `assets-upload-session` 的 `buckets`
 * 只列「需要上传」的哈希（内容未变就不重传）。实测两件事：
 *   1. 对已入库的哈希重新上传以改类型 → **HTTP 401 Unauthorized**（session JWT 只授权 buckets 内的哈希）；
 *   2. 哈希掺入类型（等同内容变更）→ HTTP 201 接受，serving 类型随之上新。
 * 后果：**只改 MIME 映射而不换哈希，存量实例的类型永远修不好**（生产 `team.handywote.top` 正是此状态）。
 * 把类型纳入哈希 key = 「凡是影响响应内容的输入都进 key」，于是：首部署即正确、**重跑部署即可修复存量实例（幂等）**、
 * 以后映射再改动也会自动重传受影响的文件。
 *
 * 与 wrangler hashFile（`blake3(base64+ext)`）的差异是有意为之（上述实测理由）；32 位 hex 形状保持一致——
 * #244 实测：哈希截短到 10 位会导致资产 500（形状/寻址约束），故仍取前 32 位 hex。
 */
export function assetHash(absPath: string): string {
  const content = readFileSync(absPath);
  const base64 = content.toString('base64');
  const ext = extname(absPath).slice(1);
  // 类型与上传 part 的类型同源（同一个 contentTypeForPath），防「哈希算一套、上传发另一套」的漂移
  return blake3Hash(`${base64}${ext}\u0000${contentTypeForPath(absPath)}`).slice(0, 32);
}

function extname(p: string): string {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i);
}

/**
 * blake3（与 wrangler 4.129.0 hash.ts 同款）：blake3-wasm 用 fs 相对路径加载 `blake3_js_bg.wasm`，
 * **无法进 bundle**，只能从 node_modules 真实文件树 require——安装器把它列为直接依赖，
 * npm/pnpm 装上即可解析（#303 起不再有 `<artifacts>/vendor` 副本这一路）。
 * 解析不到就报错带病因（装一半的装配比报错更糟）。
 */
function blake3Hash(input: string): string {
  const require_ = createRequire(import.meta.url);
  const candidates = ['blake3-wasm'];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const blake3 = require_(candidate) as { hash(input: string): { toString(enc: string): string } };
      return blake3.hash(input).toString('hex');
    } catch (err) {
      failures.push(`${candidate}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  throw new Error(
    `blake3 不可用（资产哈希必需）：${failures.join('；')}——请跑 'pnpm install'（blake3-wasm 是安装器的直接依赖）`
  );
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

/**
 * 批量上传缺失文件（base64 form，字段=哈希；part 的 Content-Type 按扩展名给——#279）；
 * 返回 completion JWT。
 */
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
    const assetPath = byHash.get(hash)!;
    const abs = join(dir, assetPath);
    // #279：每个 part 的 Content-Type 决定 serving 类型（CF 直传契约，见 mime.ts 文件头）。
    // 写死 octet-stream 会让浏览器拒执行 type="module" 脚本、把 HTML 当下载 → 白屏。
    form.append(
      hash,
      new Blob([readFileSync(abs).toString('base64')], { type: contentTypeForPath(assetPath) }),
      hash,
    );
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
