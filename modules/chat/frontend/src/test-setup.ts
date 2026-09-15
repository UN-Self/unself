// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Vitest 全局准备（#218）：当前 jsdom 版本在 Node 26 下不提供 localStorage
 * （sessionStorage 正常）——以内存 Map 实现补齐 window.localStorage，
 * 行为面（getItem/setItem/removeItem/clear）与真实一致，够测试用。
 */
import { beforeEach } from 'vitest'

type Store = Record<string, string>

function installMemoryLocalStorage(): void {
  const existing = (globalThis as { localStorage?: Storage | undefined }).localStorage
  if (existing) return
  const store: Store = {}
  const storage: Storage = {
    get length() {
      return Object.keys(store).length
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key]
    },
    getItem: (key: string) => (key in store ? store[key]! : null),
    key: (index: number) => Object.keys(store)[index] ?? null,
    removeItem: (key: string) => {
      delete store[key]
    },
    setItem: (key: string, value: string) => {
      store[key] = String(value)
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
}

installMemoryLocalStorage()

beforeEach(() => {
  globalThis.localStorage.clear()
})
