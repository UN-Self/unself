// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 云笺（docs 模块）前端类型：与 REST 契约逐字对齐。
 * 契约真值：issue #358 §6、app/modules/docs/src/routes.ts（PR #365）。
 * 本文件不含任何取巧的别名——后端字段改名，这里必须跟着改，测试会红。
 */

/** 角色裁决：owner 由 documents.owner_id 判定，editor/viewer 来自 members 表。 */
export type DocRole = 'owner' | 'editor' | 'viewer'

/** 文档行（后端 camelCase 映射后的形状；时间一律 ISO 8601 UTC）。 */
export interface Doc {
  id: string
  title: string
  content: string
  ownerId: string
  /** 乐观锁版本号，从 1 起；每次成功保存 +1。 */
  version: number
  createdAt: string
  updatedAt: string
  /** 详情端点带 role（GET /api/docs/:id）；列表端点同样带。 */
  role: DocRole
}

/** 本地草稿：只有用户能改的两个字段。 */
export interface DocDraft {
  title: string
  content: string
}

/** PUT /api/docs/:id 的请求体。 */
export interface SaveRequest {
  id: string
  title: string
  content: string
  /** 与服务端不一致即 409。 */
  baseVersion: number
}

/** 保存结果：200 与 409 是两种正常返回，不是异常。 */
export type SaveResult =
  | { ok: true; doc: Doc }
  | { ok: false; reason: 'conflict'; current: Doc }

/** 服务端错误码全表（PR #365 errors.ts）。前端只做翻译，不猜语义。 */
export type DocErrorCode =
  | 'missing_bearer_token'
  | 'token_invalid'
  | 'jwks_unavailable'
  | 'invalid_request'
  | 'not_found'
  | 'forbidden'
  | 'version_conflict'
  | 'not_implemented'

/** 错误码 → 人能看懂的一句话（后端只回 { error }，文案归前端）。 */
export const DOC_ERROR_TEXT: Record<DocErrorCode, string> = {
  missing_bearer_token: '登录状态已失效，请刷新页面重新进入。',
  token_invalid: '登录状态已失效，请刷新页面重新进入。',
  jwks_unavailable: '平台暂时无法校验身份，请联系管理员。',
  invalid_request: '请求内容不合法，请检查标题与正文。',
  not_found: '文档不存在，或你没有访问权限。',
  forbidden: '你没有这份文档的编辑权限。',
  version_conflict: '这份文档已被他人保存，请选择如何处理。',
  not_implemented: '这个功能还没实现（后端 501）。',
}

/** 把服务端错误码翻成人话；未知码兜底，不抛。 */
export function errorText(code: string): string {
  return DOC_ERROR_TEXT[code as DocErrorCode] ?? '操作失败，请稍后重试。'
}

/** 角色能不能改这份文档（viewer 只读）。 */
export function roleCanEdit(role: DocRole): boolean {
  return role === 'owner' || role === 'editor'
}
