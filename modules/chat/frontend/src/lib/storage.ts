// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块本地存储（#218）：浏览器侧持久化统一走 `unself.chat.*` 键前缀
 * （architecture.md 模块卫生规则：存储键前缀 = `unself.<模块id>.*`）。
 * 只放界面偏好（如最后打开的会话），绝不放凭证——模块 token 只在内存，
 * 过期由 SDK 静默续期换新（§5.2 ⑥）。
 */

/** 存储键前缀（unself.<moduleId>.*，architecture.md 模块章节卫生规则）。 */
export const CHAT_STORAGE_PREFIX = 'unself.chat.'

/** 最小存储面（localStorage 形状；测试可注入内存实现）。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ChatStorage {
  /** 读取原始字符串；不存在返回 null。 */
  get(key: string): string | null
  /** 写入原始字符串（覆盖写）。 */
  set(key: string, value: string): void
  /** 删除键（幂等）。 */
  remove(key: string): void
  /** 读 JSON；坏值/缺失回退 fallback。 */
  getJSON<T>(key: string, fallback: T): T
  /** 写 JSON。 */
  setJSON(key: string, value: unknown): void
}

function assertKey(key: string): void {
  if (key.length === 0) {
    throw new Error('chat-storage: key 必须为非空字符串')
  }
}

/** 默认底层：浏览器 localStorage；不可用（非浏览器/拒绝访问）时退化为内存实现。 */
function defaultStorage(): StorageLike {
  const memory = new Map<string, string>()
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    // 隐私模式可能拒绝访问 localStorage，走内存兜底
  }
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value)
    },
    removeItem: (key) => {
      memory.delete(key)
    },
  }
}

/** 创建带 `unself.chat.` 前缀收口的模块存储；key 入参只写业务裸键。 */
export function createChatStorage(storage: StorageLike = defaultStorage()): ChatStorage {
  const fullKey = (key: string): string => `${CHAT_STORAGE_PREFIX}${key}`
  return {
    get(key: string): string | null {
      assertKey(key)
      return storage.getItem(fullKey(key))
    },
    set(key: string, value: string): void {
      assertKey(key)
      storage.setItem(fullKey(key), value)
    },
    remove(key: string): void {
      assertKey(key)
      storage.removeItem(fullKey(key))
    },
    getJSON<T>(key: string, fallback: T): T {
      const raw = this.get(key)
      if (raw === null) return fallback
      try {
        return JSON.parse(raw) as T
      } catch {
        // 坏值不致命：回退默认并清掉脏数据
        this.remove(key)
        return fallback
      }
    },
    setJSON(key: string, value: unknown): void {
      this.set(key, JSON.stringify(value))
    },
  }
}
