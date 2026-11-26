// SPDX-License-Identifier: AGPL-3.0-only
import type { CalendarEvent, EventChange, EventStatus } from '../../../src/types'

import { isMock } from './mode'

/** 接口客户端：mock 走内存假数据，live 打模块后端，模式由 mode.ts 决定。 */

/** 真接口前缀：默认空串表示跟当前页面同源，/m/calendar 前缀由宿主剥掉。 */
const API_BASE = import.meta.env.VITE_API_BASE ?? ''

/** token 提供者：握手完成后由 App 注入，真接口请求时拼 Bearer。mock 模式下不使用。 */
let getToken: (() => string | null) | null = null
export function setTokenProvider(provider: () => string | null): void {
  getToken = provider
}

function authHeaders(): Record<string, string> {
  const token = getToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** 服务端返回的冲突信息：409 时抛这个错，带上服务端当前值与最近改动人。 */
export class VersionConflictError extends Error {
  constructor(
    public readonly event: CalendarEvent,
    public readonly version: number,
    public readonly actorName: string | null = null,
  ) {
    super('version_conflict')
    this.name = 'VersionConflictError'
  }
}

/** 登录过期：401 时抛这个错，界面提示重新登录。 */
export class AuthExpiredError extends Error {
  constructor() {
    super('登录已过期，请重新登录')
    this.name = 'AuthExpiredError'
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly field?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface EventPatch {
  title?: string
  description?: string | null
  location?: string | null
  startAt?: number
  endAt?: number
  status?: EventStatus
  version: number
}

export interface ChangesResult {
  changes: EventChange[]
  cursor: number
}

// ---- mock 内存状态 ----
let mockEvent: CalendarEvent | null = null
let mockChanges: EventChange[] = []
let mockChangeId = 0

function loadMock(): void {
  if (mockEvent) return
  mockEvent = {
    id: 'demo-1',
    uid: 'demo-1@example',
    title: '产品周会',
    description: '对齐本周进度',
    location: '3 楼会议室',
    startAt: Date.parse('2026-11-20T10:00:00Z'),
    endAt: Date.parse('2026-11-20T11:00:00Z'),
    allDay: false,
    timezone: 'Asia/Shanghai',
    organizerId: 'u1',
    responseState: 'accepted',
    rrule: null,
    status: 'confirmed',
    version: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
  }
}

/** 演示用：模拟「别人保存了一次」，让版本 +1 并写一条变更流。 */
export function mockSimulateRemoteEdit(fields: string[], actorName = '同学 A'): void {
  loadMock()
  if (!mockEvent) return
  const now = Date.now()
  // 演示用：真的把字段值换成新值，这样刷新和两版对比都能一眼看出差异
  const next = { ...mockEvent }
  if (fields.includes('title')) next.title = '周会（改后）'
  if (fields.includes('location')) next.location = '5 楼会议室'
  mockEvent = { ...next, version: mockEvent.version + 1, updatedAt: now }
  mockChanges.push({
    eventId: mockEvent.id,
    actorName,
    toVersion: mockEvent.version,
    changedFields: fields,
    createdAt: now,
  })
  mockChangeId += 1
}

export async function fetchEvent(id: string): Promise<CalendarEvent> {
  if (isMock()) {
    loadMock()
    if (!mockEvent || mockEvent.id !== id) throw new ApiError('not_found', 404)
    return { ...mockEvent }
  }
  const res = await fetch(`${API_BASE}/api/events/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  })
  if (res.status === 401) throw new AuthExpiredError()
  if (!res.ok) throw new ApiError('加载日程失败', res.status)
  const body = (await res.json()) as { event: CalendarEvent }
  return body.event
}

export async function patchEvent(id: string, patch: EventPatch): Promise<CalendarEvent> {
  if (isMock()) {
    loadMock()
    if (!mockEvent || mockEvent.id !== id) throw new ApiError('not_found', 404)
    if (patch.version !== mockEvent.version) {
      throw new VersionConflictError({ ...mockEvent }, mockEvent.version, '同学 A')
    }
    const next: CalendarEvent = {
      ...mockEvent,
      ...patch,
      version: mockEvent.version + 1,
      updatedAt: Date.now(),
    }
    mockEvent = next
    return { ...next }
  }
  const res = await fetch(`${API_BASE}/api/events/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  })
  if (res.status === 401) throw new AuthExpiredError()
  if (res.status === 409) {
    const body = (await res.json()) as { event: CalendarEvent; version: number; actorName?: string | null }
    throw new VersionConflictError(body.event, body.version, body.actorName ?? null)
  }
  if (res.status === 400) {
    // 后端校验失败带 error 码和可选 field，交给界面翻成中文定位问题
    const body = (await res.json()) as { error?: string; field?: string }
    throw new ApiError('保存失败', res.status, body.error, body.field)
  }
  if (!res.ok) throw new ApiError('保存失败', res.status)
  const body = (await res.json()) as { event: CalendarEvent }
  return body.event
}

export async function fetchChanges(since: number): Promise<ChangesResult> {
  if (isMock()) {
    const rows = mockChanges.filter((c) => c.createdAt >= since)
    const cursor = rows.length > 0 ? Math.max(since, rows[rows.length - 1]!.createdAt) : since
    return { changes: [...rows], cursor }
  }
  const params = new URLSearchParams({ since: String(since) })
  const res = await fetch(`${API_BASE}/api/events/changes?${params.toString()}`, {
    headers: authHeaders(),
  })
  if (res.status === 401) throw new AuthExpiredError()
  if (!res.ok) throw new ApiError('拉取变更失败', res.status)
  return (await res.json()) as ChangesResult
}
