// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CF REST 客户端内核（决策 #65：装配器不安装、不调用 wrangler）：
 * - Bearer token（CLOUDFLARE_API_TOKEN 或借 wrangler OAuth，见 token.ts）；
 * - v4 信封解析（success/errors/result），错误 → CloudflareApiError（code/message/status）；
 * - fetch 注入（测试替身）；multipart 上传用原生 FormData。
 * 端点形状实测：wrangler 4.129.0 源码 + 2026-09-17 真机探针（issue #244）。
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

/** v4 信封。 */
export interface CfEnvelope<T = unknown> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
}

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly status: number,
    readonly errors: Array<{ code: number; message: string }>,
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

export interface RestClientOptions {
  token: string;
  /** 注入 fetch（测试替身）；缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 重试：429/5xx 指数退避（默认 2 次）。 */
  retries?: number;
  /** 单次请求基础超时 ms（默认 30s）。 */
  timeoutMs?: number;
}

export class RestClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #retries: number;
  readonly #timeoutMs: number;

  /** 注入 fetch 的只读暴露（d1 import 的 presigned PUT 复用同源替身；不含 token）。 */
  get fetchImpl(): typeof fetch {
    return this.#fetch;
  }

  /** 凭证只读暴露（assets 会话端点走裸 fetch 组头时用；不落日志）。 */
  get token(): string {
    return this.#token;
  }

  constructor(opts: RestClientOptions) {
    this.#token = opts.token;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#retries = opts.retries ?? 2;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** path 以 / 开头（相对 API 根）；绝对 URL（R2 presigned 等）原样用。 */
  async request<T>(method: string, path: string, init?: RequestInit): Promise<CfEnvelope<T>> {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${this.#token}`);
    if (init?.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      try {
        const res = await this.#fetch(url, {
          ...init,
          method,
          headers,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        // 429 / 5xx：指数退避重试
        if ((res.status === 429 || res.status >= 500) && attempt < this.#retries) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        const text = await res.text();
        let json: CfEnvelope<T>;
        try {
          json = JSON.parse(text) as CfEnvelope<T>;
        } catch {
          // 非 JSON（如 R2 presigned PUT 的空体 / 网关 HTML）
          if (!res.ok) {
            throw new CloudflareApiError(`HTTP ${res.status}（非 JSON 响应：${text.slice(0, 120)}）`, 0, res.status, []);
          }
          json = { success: true, result: undefined as T, errors: [] };
        }
        if (!res.ok || json.success === false) {
          const errs = json.errors ?? [];
          const detail = errs.map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${res.status}`;
          throw new CloudflareApiError(`CF API ${method} ${path} 失败：${detail}`, errs[0]?.code ?? 0, res.status, errs);
        }
        return json;
      } catch (err) {
        if (err instanceof CloudflareApiError) throw err;
        lastErr = err;
        if (attempt < this.#retries) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
      }
    }
    throw new CloudflareApiError(`CF API ${method} ${path} 网络失败：${String(lastErr)}`, 0, 0, []);
  }

  get<T>(path: string): Promise<CfEnvelope<T>> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<CfEnvelope<T>> {
    return this.request<T>('POST', path, { body: body === undefined ? undefined : JSON.stringify(body) });
  }
  put<T>(path: string, body?: unknown): Promise<CfEnvelope<T>> {
    return this.request<T>('PUT', path, { body: body === undefined ? undefined : JSON.stringify(body) });
  }
  delete<T>(path: string): Promise<CfEnvelope<T>> {
    return this.request<T>('DELETE', path);
  }

  /** multipart 上传（worker 脚本 / 资产批量）：fetch 直发，信封同解析。 */
  async putMultipart<T>(path: string, form: FormData): Promise<CfEnvelope<T>> {
    return this.request<T>('PUT', path, { body: form });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 账户 id（多账户取第一个；core 既有行为同款）。 */
export async function findAccountId(client: RestClient): Promise<string | null> {
  const res = await client.get<Array<{ id: string }>>('/accounts');
  return res.result[0]?.id ?? null;
}
