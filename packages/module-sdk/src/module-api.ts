// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 浏览器侧模块 API 客户端（决策 #63：跨域模块的「模块 → core」通道）：
 *
 * 跨域模块页（publicUrl 独立 origin）里的浏览器代码要直调 Core API
 * （/api/module-api/*）。fetch 以 coreOrigin 为基准展开相对端点；
 * Authorization 头带模块 token（由握手消息投递，绝不入 localStorage）。
 * server 侧按注册表 origin 白名单开 CORS（middleware/module-api-cors.ts），
 * 同域路径制模块照常可用（相对解析落在同一 origin，不触发跨域）。
 */

/** Core API 端点相对路径（基准 = coreOrigin）。 */
export type ModuleApiPath = `/api/module-api/${string}`;

/** 最小 fetch 面（node 侧测试注入；浏览器原生 fetch 天然满足）。 */
export type ModuleApiFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface CreateModuleApiOptions {
  /** 壳页面 origin（如 https://team.example.com）：全部请求的基准（决策 #63 必填、禁 '*'）。 */
  coreOrigin: string;
  /** 取当前模块 token（每次请求现场取，续期后自动用新 token）。 */
  getToken: () => string | undefined;
  /** 自定义 fetch（测试注入用）；缺省用全局 fetch。 */
  fetchImpl?: ModuleApiFetcher;
}

export interface ModuleApi {
  /** 通用请求：展开到 coreOrigin、带 Authorization 与 JSON 头。 */
  request(path: ModuleApiPath, init?: { method?: string; body?: unknown }): Promise<Response>;
  /** 存储四形状（core 落点）：get/put/delete/list。 */
  storageGet(key: string): Promise<string | null>;
  storagePut(key: string, value: string): Promise<void>;
  storageDelete(key: string): Promise<void>;
  storageList(): Promise<string[]>;
}

/** coreOrigin 必须是确切 https origin（决策 #63 硬禁止 '*' 与 http 明文）。 */
export function assertCoreOrigin(coreOrigin: string): void {
  if (coreOrigin === '*') {
    throw new Error(
      'module-sdk: coreOrigin 禁止为 "*"（决策 #63）：通配无法校验入站来源，' +
        '必须填壳的确切 https origin',
    );
  }
  let url: URL;
  try {
    url = new URL(coreOrigin);
  } catch {
    throw new Error(`module-sdk: coreOrigin=${coreOrigin} 不是可解析的 origin`);
  }
  if (url.protocol !== 'https:' || url.origin !== coreOrigin) {
    throw new Error(
      `module-sdk: coreOrigin=${coreOrigin} 必须是确切的 https origin（如 https://team.example.com）`,
    );
  }
}

export function createModuleApi(options: CreateModuleApiOptions): ModuleApi {
  assertCoreOrigin(options.coreOrigin);
  const fetchImpl: ModuleApiFetcher = options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function request(path: ModuleApiPath, init?: { method?: string; body?: unknown }): Promise<Response> {
    const token = options.getToken();
    if (!token) {
      throw new Error('module-sdk: no module token available (handshake not completed?)');
    }
    return fetchImpl(`${options.coreOrigin}${path}`, {
      method: init?.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  return {
    request,
    async storageGet(key) {
      const res = await request(`/api/module-api/storage/${encodeURIComponent(key)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`module-sdk: storage get failed: HTTP ${res.status}`);
      const body = (await res.json()) as { value?: unknown };
      return typeof body.value === 'string' ? body.value : null;
    },
    async storagePut(key, value) {
      const res = await request(`/api/module-api/storage/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: { value },
      });
      if (!res.ok) throw new Error(`module-sdk: storage put failed: HTTP ${res.status}`);
    },
    async storageDelete(key) {
      const res = await request(`/api/module-api/storage/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`module-sdk: storage delete failed: HTTP ${res.status}`);
    },
    async storageList() {
      const res = await request('/api/module-api/storage/');
      if (!res.ok) throw new Error(`module-sdk: storage list failed: HTTP ${res.status}`);
      const body = (await res.json()) as { keys?: unknown };
      return Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === 'string') : [];
    },
  };
}
