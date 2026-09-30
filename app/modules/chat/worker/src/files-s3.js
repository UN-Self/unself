// SPDX-License-Identifier: AGPL-3.0-only
// #310 新增（unself 集成层，非上游件）：chat 自备 S3 的 FILES 适配器（最小子集）。
// 上游把 env.FILES 当 Cloudflare R2 绑定用（put/get/delete 三处）；这里给出一个同形对象，
// 让上游调用点零改动。签名用 AWS Signature V4（WebCrypto 实现，零新依赖）。
// 边界：缺任一必填项直接 throw，不静默回退到其他存储来源。

const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const encoder = new TextEncoder();

function requireConfigValue(config, key) {
  const value = config?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`S3 配置缺少必填项：${key}`);
  }
  return value.trim();
}

export function createS3Files(config, fetchImpl = fetch) {
  const credentials = {
    endpoint: requireConfigValue(config, 'endpoint').replace(/\/+$/, ''),
    region: requireConfigValue(config, 'region'),
    bucket: requireConfigValue(config, 'bucket'),
    accessKeyId: requireConfigValue(config, 'accessKeyId'),
    secretAccessKey: requireConfigValue(config, 'secretAccessKey')
  };
  const endpointUrl = new URL(credentials.endpoint);

  async function put(key, value, options = {}) {
    const body = toUint8Array(value);
    const payloadHash = await sha256Hex(body);
    const httpMetadata = options.httpMetadata || {};
    const customMetadata = options.customMetadata || {};
    const extraHeaders = {};
    if (httpMetadata.contentType) {
      extraHeaders['content-type'] = String(httpMetadata.contentType);
    }
    if (httpMetadata.cacheControl) {
      extraHeaders['cache-control'] = String(httpMetadata.cacheControl);
    }
    for (const [name, metadataValue] of Object.entries(customMetadata)) {
      extraHeaders[`x-amz-meta-${name.toLowerCase()}`] = String(metadataValue);
    }

    const request = await signRequest({ method: 'PUT', key, extraHeaders, payloadHash });
    const response = await fetchImpl(request.url, {
      method: 'PUT',
      headers: request.headers,
      body
    });
    if (!response.ok) {
      throw s3Error('PUT', key, response);
    }
    return { key, etag: response.headers.get('etag') };
  }

  async function get(key) {
    const request = await signRequest({
      method: 'GET',
      key,
      extraHeaders: {},
      payloadHash: EMPTY_PAYLOAD_SHA256
    });
    const response = await fetchImpl(request.url, { method: 'GET', headers: request.headers });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw s3Error('GET', key, response);
    }

    const httpMetadata = {
      contentType: response.headers.get('content-type') || undefined,
      cacheControl: response.headers.get('cache-control') || undefined
    };
    const customMetadata = {};
    response.headers.forEach((metadataValue, name) => {
      if (name.toLowerCase().startsWith('x-amz-meta-')) {
        customMetadata[name.toLowerCase().slice('x-amz-meta-'.length)] = metadataValue;
      }
    });
    const lastModified = response.headers.get('last-modified');

    let cachedBody = null;
    return {
      async arrayBuffer() {
        if (!cachedBody) {
          cachedBody = await response.arrayBuffer();
        }
        return cachedBody;
      },
      writeHttpMetadata(headers) {
        if (httpMetadata.contentType) {
          headers.set('content-type', httpMetadata.contentType);
        }
        if (httpMetadata.cacheControl) {
          headers.set('cache-control', httpMetadata.cacheControl);
        }
      },
      uploaded: lastModified ? new Date(lastModified) : null,
      customMetadata
    };
  }

  async function remove(key) {
    const request = await signRequest({
      method: 'DELETE',
      key,
      extraHeaders: {},
      payloadHash: EMPTY_PAYLOAD_SHA256
    });
    const response = await fetchImpl(request.url, { method: 'DELETE', headers: request.headers });
    if (!response.ok) {
      throw s3Error('DELETE', key, response);
    }
  }

  async function list({ limit = 1000, prefix = '' } = {}) {
    const query = { 'list-type': '2', 'max-keys': String(limit) };
    if (prefix) {
      query.prefix = String(prefix);
    }
    const request = await signRequest({
      method: 'GET',
      key: null,
      query,
      extraHeaders: {},
      payloadHash: EMPTY_PAYLOAD_SHA256
    });
    const response = await fetchImpl(request.url, { method: 'GET', headers: request.headers });
    if (!response.ok) {
      throw s3Error('LIST', null, response);
    }
    const xml = await response.text();
    return { objects: parseListObjects(xml) };
  }

  // 记录签名时刻：同一次请求的所有签名派生共用同一 amzDate，避免跨秒漂移。
  async function signRequest({ method, key, query, extraHeaders, payloadHash }) {
    const { amzDate, dateStamp } = formatAmzDate(new Date());
    const path = canonicalUri(credentials.bucket, key);
    const search = canonicalQuery(query);
    const signingHeaders = {
      host: endpointUrl.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders
    };
    const { names: signedHeaders, values: headerBlock } = canonicalHeaders(signingHeaders);
    const canonicalRequest = `${method}\n${path}\n${search}\n${headerBlock}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${dateStamp}/${credentials.region}/${SERVICE}/aws4_request`;
    const stringToSign = `${ALGORITHM}\n${amzDate}\n${scope}\n${await sha256Hex(encoder.encode(canonicalRequest))}`;
    const signingKey = await deriveSigningKey(
      credentials.secretAccessKey,
      dateStamp,
      credentials.region
    );
    const signature = bytesToHex(await hmacSha256(signingKey, encoder.encode(stringToSign)));

    return {
      url: `${credentials.endpoint}${path}${search ? `?${search}` : ''}`,
      headers: {
        ...extraHeaders,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
      }
    };
  }

  return { put, get, delete: remove, list };
}

function toUint8Array(value) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('S3 put 的 value 必须是 ArrayBuffer 或 TypedArray');
}

function bytesToHex(bytes) {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = typeof message === 'string' ? encoder.encode(message) : message;
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data));
}

async function deriveSigningKey(secretAccessKey, dateStamp, region) {
  const kDate = await hmacSha256(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, SERVICE);
  return hmacSha256(kService, 'aws4_request');
}

function formatAmzDate(date) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

// SigV4 的 RFC3986 编码：encodeURIComponent 已满足除 !'()* 外的 unreserved 集合。
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function canonicalUri(bucket, key) {
  const segments = key ? [bucket, ...String(key).split('/')] : [bucket];
  return `/${segments.map(encodeRfc3986).join('/')}`;
}

function canonicalQuery(query) {
  return Object.entries(query || {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(String(value))])
    .sort(([nameA, valueA], [nameB, valueB]) => {
      if (nameA !== nameB) return nameA < nameB ? -1 : 1;
      if (valueA !== valueB) return valueA < valueB ? -1 : 1;
      return 0;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function canonicalHeaders(headers) {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).replace(/\s+/g, ' ').trim()])
    .sort(([nameA], [nameB]) => (nameA < nameB ? -1 : nameA > nameB ? 1 : 0));
  return {
    names: entries.map(([name]) => name).join(';'),
    values: entries.map(([name, value]) => `${name}:${value}`).join('\n')
  };
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractXmlTag(block, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? decodeXml(match[1]) : '';
}

function parseListObjects(xml) {
  const objects = [];
  const pattern = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const block = match[1];
    const lastModified = extractXmlTag(block, 'LastModified');
    objects.push({
      key: extractXmlTag(block, 'Key'),
      size: Number(extractXmlTag(block, 'Size') || 0),
      uploaded: lastModified ? new Date(lastModified) : null
    });
  }
  return objects;
}

function s3Error(operation, key, response) {
  const error = new Error(
    `S3 ${operation} 失败：HTTP ${response.status}${key ? `（${key}）` : ''}`
  );
  error.status = response.status;
  return error;
}
