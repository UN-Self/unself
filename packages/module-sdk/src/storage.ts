// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块存储客户端（#248 收敛（a)：模块 worker 侧统一经 Core API 代理访问数据）。
 *
 * 决策背景（issue #248 硬约束，决策 #75）：
 *   旧 createD1Storage 让模块直连 MODULES_DB（绑定 D1），而 /api/module-api/storage/*
 *   （Core API 代理）零调用方——「SDK 直连 D1」与「Core API 代理」两条路径并存。
 *   本 issue 收敛为 (a)：模块不再直连数据库；core 级数据一律走代理四形状
 *   （get/put/delete/list，不承诺关系表，决策 #55）。
 *
 * 落点与通道：
 * - core      ：本客户端（Core API 代理）——唯一承诺的通道；
 * - shared    ：模块在自己的库直连建表（MODULES_DB 绑定 + 独立记账迁移），不经本客户端；
 * - dedicated ：模块在专属库直连（<ID>_DB 绑定），不经本客户端；
 * - external  ：模块连自备外部库（连接串走配置页），不经本客户端。
 *
 * 兼容：createD1Storage 形状保留，但实现改为 Core API 代理绑定
 * （`db.prepare(...).bind(...).first/all/run` → HTTP 四形状）——老调用点零改动迁移。
 */
export interface ModuleStorage {
  /** 读取键值；不存在返回 null。 */
  get(key: string): Promise<string | null>;
  /** 写入键值（覆盖写）。 */
  put(key: string, value: string): Promise<void>;
  /** 删除键值（幂等：不存在也成功）。 */
  delete(key: string): Promise<void>;
  /** 列出前缀下的键（未提供 prefix 时列出该模块全部键），按键排序。 */
  list(prefix?: string): Promise<string[]>;
}

/**
 * Core API 代理绑定（最小结构面）：module worker 注入 CORE_API_ORIGIN（部署期 vars）
 * 后构造；fetch 以 origin 为基准展开 /api/module-api/storage/*。
 * 认证头由 authFetch 供（模块 token，每次现场取，续期后自动用新 token）。
 */
export interface CoreApiProxyBinding {
  /** Core API origin（如 https://team.example.com）；禁止 '*'。 */
  coreApiOrigin: string;
  /** 取当前模块 token（每次请求现场取）。 */
  getToken: () => string | undefined;
  /** 最小 fetch 面（workerd 全局 fetch 天然满足；测试注入替身）。 */
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
}

/** moduleId 只允许常规标识符：字母/数字开头，后续 [A-Za-z0-9_-]。 */
const MODULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 键守卫：非空且不含保留分隔符 ':'（语义与历史直连版一致，跨前缀注入一律拒绝）。 */
function assertKey(key: string, moduleId: string): void {
  if (key.length === 0) {
    throw new Error(`storage: key 必须为非空字符串（moduleId=${moduleId}）`);
  }
  if (key.includes(':')) {
    throw new Error(
      `storage: key ${JSON.stringify(key)} 含保留分隔符 ':'，拒绝跨前缀访问（moduleId=${moduleId}）`,
    );
  }
}

/**
 * 创建 Core API 代理存储客户端（#248 收敛（a)：core 级唯一通道）。
 *
 * 返回历史 ModuleStorage 形状；list(prefix) 在代理侧无参数，前缀过滤在客户端做
 * （全量列出后按前缀过滤——代理 GET /storage/ 本就只列本模块子域键，量级=模块自身）。
 */
export function createCoreApiStorage(binding: CoreApiProxyBinding): ModuleStorage {
  const { coreApiOrigin } = binding;
  if (coreApiOrigin === '*') {
    throw new Error('storage: coreApiOrigin 禁止为 "*"（决策 #63）——必须填 Core API 的确切 https origin');
  }

  async function request(path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
    const token = binding.getToken();
    if (!token) {
      throw new Error('storage: no module token available（模块 token 未注入/未续期）');
    }
    return binding.fetchImpl(`${coreApiOrigin}${path}`, {
      method: init?.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  return {
    async get(key: string): Promise<string | null> {
      assertKey(key, coreApiOrigin);
      const res = await request(`/api/module-api/storage/${encodeURIComponent(key)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage: get failed: HTTP ${res.status}`);
      const body = (await res.json()) as { value?: unknown };
      return typeof body.value === 'string' ? body.value : null;
    },

    async put(key: string, value: string): Promise<void> {
      assertKey(key, coreApiOrigin);
      const res = await request(`/api/module-api/storage/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: { value },
      });
      if (!res.ok) throw new Error(`storage: put failed: HTTP ${res.status}`);
    },

    async delete(key: string): Promise<void> {
      assertKey(key, coreApiOrigin);
      const res = await request(`/api/module-api/storage/${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`storage: delete failed: HTTP ${res.status}`);
    },

    async list(prefix?: string): Promise<string[]> {
      if (prefix !== undefined && prefix.length > 0) {
        assertKey(prefix, coreApiOrigin);
      }
      const res = await request('/api/module-api/storage/');
      if (!res.ok) throw new Error(`storage: list failed: HTTP ${res.status}`);
      const body = (await res.json()) as { keys?: unknown };
      const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === 'string') : [];
      if (prefix !== undefined && prefix.length > 0) {
        // 前缀字面匹配（通配符按字面处理，语义与历史 LIKE+ESCAPE 一致）
        return keys.filter((k) => k.startsWith(prefix)).sort();
      }
      return keys.sort();
    },
  };
}

/**
 * 兼容别名（#248 收敛（a)）：历史 createD1Storage 调用点零改动迁移。
 * 旧签名第一参的 { db: D1MinimalDatabase, moduleId } 不再接受——重载仅收代理绑定；
 * 传旧形态时给出人话迁移指引（红灯验证：直连路径已死，传绑定即拒）。
 */
export function createD1Storage(options: CoreApiProxyBinding & { moduleId?: string }): ModuleStorage {
  const maybeDb = (options as { db?: unknown }).db;
  if (maybeDb !== undefined) {
    throw new Error(
      'storage: createD1Storage 已收敛到 Core API 代理（#248，决策 #75）——模块不再直连 MODULES_DB。' +
        '请改传 { coreApiOrigin, getToken, fetchImpl }（core 级），或声明 shared/dedicated 落点并直连自己的库。',
    );
  }
  return createModuleStorage(options as CoreApiProxyBinding & { moduleId: string });
}

/**
 * 兼容入口（历史形状）：旧调用点传 { db, moduleId } 的地方改为传代理绑定。
 * 这里提供 createCoreApiStorage 的参数化包装—— moduleId 仅用于报错文案与守卫。
 */
export function createModuleStorage(options: CoreApiProxyBinding & { moduleId: string }): ModuleStorage {
  if (!MODULE_ID_PATTERN.test(options.moduleId)) {
    throw new Error(`storage: 非法 moduleId ${JSON.stringify(options.moduleId)}`);
  }
  return createCoreApiStorage(options);
}
