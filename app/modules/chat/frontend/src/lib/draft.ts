// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Composer 草稿持久化（#218 C 路）：`unself.chat.draft.<kind>.<roomId>` 键；
 * 保存经 300ms debounce（连续输入不刷存储），加载/清除即时。
 * localStorage 不可用（隐私模式/非浏览器）时静默降级到内存 Map——会话内仍在，
 * 跨刷新丢失可接受（草稿属易失 UI 状态）。
 * #347 治本：草稿值从纯文本升级为结构化 part——mention chip（含 @all 标记）切房/刷新后
 * 可完整重建；旧版纯文本草稿按单条 text part 兼容读回。附件 part 不入草稿（文件走提交链路）。
 */

import type { RichInputPart } from '@unself/ui'

/** 保存 debounce（ms）：任务书口径 300ms。 */
export const DRAFT_SAVE_DELAY_MS = 300

const DRAFT_PREFIX = 'unself.chat.draft.'

/** 草稿里的合法 part：文本与提及 chip。附件只存过 id、恢复不了预览，不入草稿。 */
export type DraftPart = Extract<RichInputPart, { type: 'text' | 'mention' }>

/** 底层存储最小形状（localStorage 与内存兜底共用）。 */
interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** 兼容直接传 localStorage：TS 结构化下 Map 非法、localStorage 多出无关成员无妨。 */
  [key: string]: unknown
}

/** 内存兜底：localStorage 抛错/缺失时的会话内降级。 */
const memoryFallback = new Map<string, string>()

function resolveStorage(): DraftStorage {
  const memory: DraftStorage = {
    getItem: (key) => memoryFallback.get(key) ?? null,
    setItem: (key, value) => {
      memoryFallback.set(key, value)
    },
    removeItem: (key) => {
      memoryFallback.delete(key)
    },
  }
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    // 隐私模式拒绝访问 → 落内存
  }
  return memory
}

function draftKey(kind: string, roomId: number | string): string {
  return `${DRAFT_PREFIX}${kind}.${roomId}`
}

/** 存储值 → part：JSON 数组按结构读，旧版纯文本按单条 text part 兼容，坏数据落空。 */
function normalizeParts(raw: string | null): DraftPart[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return raw ? [{ type: 'text', text: raw }] : []
    return parsed.filter(
      (part): part is DraftPart =>
        part !== null && typeof part === 'object' &&
        ((part as RichInputPart).type === 'text' || (part as RichInputPart).type === 'mention'),
    )
  } catch {
    // 旧版纯文本草稿（非 JSON）：按整段文本读回
    return [{ type: 'text', text: raw }]
  }
}

export function loadDraft(kind: string, roomId: number | string): DraftPart[] {
  try {
    return normalizeParts(resolveStorage().getItem(draftKey(kind, roomId)))
  } catch {
    return []
  }
}

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 输入侧保存入口：300ms debounce，同键连续输入只落最后一次。 */
export function saveDraft(kind: string, roomId: number | string, parts: DraftPart[]): void {
  const key = draftKey(kind, roomId)
  const existing = pendingTimers.get(key)
  if (existing) clearTimeout(existing)
  pendingTimers.set(
    key,
    setTimeout(() => {
      pendingTimers.delete(key)
      try {
        if (parts.length === 0) resolveStorage().removeItem(key)
        else resolveStorage().setItem(key, JSON.stringify(parts))
      } catch {
        // 配额满等写失败 → 静默：草稿丢失可接受
      }
    }, DRAFT_SAVE_DELAY_MS),
  )
}

/** 发送/清空侧：取消挂起保存并立即删除。 */
export function clearDraft(kind: string, roomId: number | string): void {
  const key = draftKey(kind, roomId)
  const existing = pendingTimers.get(key)
  if (existing) {
    clearTimeout(existing)
    pendingTimers.delete(key)
  }
  try {
    resolveStorage().removeItem(key)
  } catch {
    // 忽略：与 load 静默降级一致
  }
}

/** 测试隔离钩子：清空内存兜底与挂起计时器（不影响 localStorage 真键）。 */
export function resetDraftsForTest(): void {
  for (const timer of pendingTimers.values()) clearTimeout(timer)
  pendingTimers.clear()
  memoryFallback.clear()
}
