// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 向导 SPA 的 API 客户端（业务视图专用薄封装）：fetch + JSON，错误归一为 { ok, data }。
 * 不做全局状态——各屏自行持有业务状态（一文件一职责）。
 */
export interface ApiFailure {
  problem: string
}

export interface StepResult<T = Record<string, unknown>> {
  ok: boolean
  status: number
  data: T & Partial<ApiFailure>
}

export async function postJson<T = Record<string, unknown>>(path: string, body: unknown): Promise<StepResult<T>> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { ok: res.ok, status: res.status, data: data as T & Partial<ApiFailure> };
}

export async function getJson<T = Record<string, unknown>>(path: string): Promise<T> {
  const res = await fetch(path);
  return (await res.json()) as T;
}
