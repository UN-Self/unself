// SPDX-License-Identifier: AGPL-3.0-only
/**
 * S3 兼容头像存储（#360 Node 运行体）：`UNSELF_FILES=s3://bucket?...` 时的实现。
 *
 * 不引 @aws-sdk：这里只需要 PUT/GET/DELETE 三个对象请求，SigV4 签名用 WebCrypto 手写，
 * 保持 Node 运行体零大型 SDK 依赖（也就能整体 bundle 进单文件）。endpoint/region/bucket/
 * accessKeyId/secretAccessKey 全部走配置；path-style 可配（MinIO 必须 `forcePathStyle=1`）。
 *
 * 签名器单独导出给测试用（AWS 官方示例向量见 test/node-entry.test.ts），存储实现只是
 * 在它之上拼 URL 与状态码语义。
 */
import type { AvatarStore } from '../services/avatar-store';

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OBJECT_PREFIX = 'core/avatars/';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface S3AvatarStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO 等不自带 virtual-host 的端点必须开（`s3://…&forcePathStyle=1`）。 */
  forcePathStyle?: boolean;
}

export interface SignS3RequestInput {
  method: string;
  /** 完整对象 URL（查询参数会进 CanonicalQueryString）。 */
  url: string;
  /** 额外请求头（小写键）；签名器会补 host/x-amz-content-sha256/x-amz-date 并全部签入。 */
  headers?: Record<string, string>;
  /** 请求体 SHA-256 hex；GET/HEAD/DELETE 用空体常量。 */
  payloadHash?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `YYYYMMDDTHHMMSSZ`；缺省取当前时间（测试用固定向量时显式传）。 */
  amzDate?: string;
}

export interface SignedS3Request {
  headers: Record<string, string>;
  authorization: string;
  canonicalRequest: string;
  /** 实际用于签名的 x-amz-date。 */
  amzDate: string;
}

/** UTC `YYYYMMDDTHHMMSSZ`（SigV4 的 x-amz-date 形状）。 */
function isoAmzDate(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** RFC 3986 编码（SigV4 canonical 用）；已解码的段再统一编码，避免双重编码。 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalUri(pathname: string): string {
  const segments = pathname.split('/').map((segment) => rfc3986(decodeURIComponent(segment)));
  return segments.join('/') || '/';
}

function canonicalQuery(search: string): string {
  const pairs: Array<[string, string]> = [];
  new URLSearchParams(search).forEach((value, key) => pairs.push([rfc3986(key), rfc3986(value)]));
  return pairs
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message)));
}

/** 签名密钥链：kDate → kRegion → kService → kSigning。 */
async function signingKey(secret: string, date: string, region: string, service: string): Promise<Uint8Array> {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secret}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * 计算 SigV4 请求头与 Authorization（不发送请求）。纯函数：同一输入永远同一签名，
 * 测试可用 AWS 官方示例向量逐字节复算。
 */
export async function signS3Request(input: SignS3RequestInput): Promise<SignedS3Request> {
  const url = new URL(input.url);
  const amzDate = input.amzDate ?? isoAmzDate();
  const date = amzDate.slice(0, 8);
  const payloadHash = input.payloadHash ?? EMPTY_SHA256;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    headers[key.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  }
  headers.host ??= url.host;
  headers['x-amz-content-sha256'] = payloadHash;
  headers['x-amz-date'] = amzDate;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const key = await signingKey(input.secretAccessKey, date, input.region, 's3');
  const signature = [...(await hmac(key, stringToSign))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, authorization, canonicalRequest, amzDate };
}

function objectKey(key: string): string {
  if (!SAFE_KEY.test(key) || key === '.' || key === '..') {
    throw new Error(`头像 key 非法：${JSON.stringify(key)}`);
  }
  return `${OBJECT_PREFIX}${key}`;
}

function objectUrl(config: S3AvatarStoreConfig, key: string): string {
  const url = new URL(config.endpoint);
  const basePath = url.pathname.replace(/\/+$/, '');
  const objectPath = `${basePath}/${key.split('/').map(rfc3986).join('/')}`;
  if (config.forcePathStyle) {
    url.pathname = `/${config.bucket}${objectPath}`;
  } else {
    url.host = `${config.bucket}.${url.host}`;
    url.pathname = objectPath;
  }
  return url.href;
}

/** S3 兼容头像存储（对象前缀与 R2 实现一致：`core/avatars/`）。 */
export function s3AvatarStore(config: S3AvatarStoreConfig): AvatarStore {
  return {
    async put(key, bytes, contentType): Promise<void> {
      const url = objectUrl(config, objectKey(key));
      const body = new Uint8Array(bytes);
      const signed = await signS3Request({
        method: 'PUT',
        url,
        headers: { 'content-type': contentType },
        payloadHash: await sha256Hex(body),
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      });
      const res = await fetch(url, {
        method: 'PUT',
        headers: { ...signed.headers, authorization: signed.authorization },
        body,
      });
      if (!res.ok) throw new Error(`S3 头像上传失败：HTTP ${res.status}`);
    },
    async get(key) {
      const url = objectUrl(config, objectKey(key));
      const signed = await signS3Request({
        method: 'GET',
        url,
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      });
      const res = await fetch(url, {
        headers: { ...signed.headers, authorization: signed.authorization },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 头像读取失败：HTTP ${res.status}`);
      return {
        body: await res.arrayBuffer(),
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      };
    },
    async delete(key): Promise<void> {
      const url = objectUrl(config, objectKey(key));
      const signed = await signS3Request({
        method: 'DELETE',
        url,
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      });
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { ...signed.headers, authorization: signed.authorization },
      });
      if (!res.ok && res.status !== 404) throw new Error(`S3 头像删除失败：HTTP ${res.status}`);
    },
  };
}
