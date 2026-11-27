// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 文档接口的业务体（issue #358 · D5）：五个端点各自的「校验 → 查角色 → 裁决 → 仓储」。
 *
 * 每条流程的顺序固定，端点不得自行调换：
 *   认证（app.ts 先做）→ 校验请求体 → findAccess 读角色 → decide 裁决 → 仓储调用。
 * 请求体先校验是因为它只反映调用方自己发了什么，不泄露任何文档的存在性；
 * 裁决在仓储之前，是因为仓储层不做鉴权。
 *
 * 裁决语义沿用 auth/policy.ts 的定案：不存在 / 已软删 / 非成员一律 404，成员但角色不够 403。
 * 列表不裁决——SQL 本身只返回「我拥有的 + 共享给我的」。
 *
 * 返回的是「结果」不是 Response：状态码与错误体的对应只留在 app.ts 一处（词表在 errors.ts）。
 */
import type { D1Like } from './d1';
import { ERROR_CODES, type ErrorCode } from './errors';
import { decide, resolveRole, type Action, type Role } from './auth/policy';
import {
  createDocument,
  findAccess,
  getDocument,
  listDocuments,
  softDeleteDocument,
  updateDocument,
  type Document,
  type DocumentWithRole,
} from './repo/documents';

/** 标题上限（字符数）。 */
export const TITLE_MAX_LENGTH = 200;
/** 列表默认每页条数（与仓储层默认值一致）。 */
const DEFAULT_LIST_LIMIT = 50;
/** 正文上限（UTF-8 字节数）。 */
export const CONTENT_MAX_BYTES = 1024 * 1024;

/** 失败：交给 app.ts 翻成状态码 + `{ error }`。 */
export type Failure = { ok: false; code: ErrorCode };

/** 保存冲突：409，体里带服务端当前文档（含调用者角色）。 */
export type Conflict = { ok: false; code: typeof ERROR_CODES.versionConflict; current: DocumentWithRole };

export type DocumentFailure = Failure | Conflict;

function fail(code: ErrorCode): Failure {
  return { ok: false, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 标题：必须是字符串，不超过 200 字符。空串放行（编辑器清空标题时不应被拒保存）。 */
function validTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length <= TITLE_MAX_LENGTH;
}

/** 正文：必须是字符串，UTF-8 不超过 1MB。 */
function validContent(value: unknown): value is string {
  return typeof value === 'string' && new TextEncoder().encode(value).length <= CONTENT_MAX_BYTES;
}

function listLimitOrOffset(raw: string | null | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/** POST /api/docs：新建，调用者即 owner（成员表不落 owner 行）。 */
export async function createDocumentAction(
  db: D1Like,
  userId: string,
  body: unknown,
): Promise<{ ok: true; document: DocumentWithRole } | Failure> {
  if (!isRecord(body) || !validTitle(body.title) || !validContent(body.content ?? '')) {
    return fail(ERROR_CODES.invalidRequest);
  }
  const document = await createDocument(db, {
    ownerId: userId,
    title: body.title,
    content: typeof body.content === 'string' ? body.content : undefined,
  });
  return { ok: true, document: { ...document, role: 'owner' as const } };
}

/** GET /api/docs：我拥有的 + 共享给我的，offset 分页。limit/offset 不是数字时取默认值。 */
export async function listDocumentsAction(db: D1Like, userId: string, query: URLSearchParams) {
  return {
    ok: true,
    page: await listDocuments(db, userId, {
      limit: listLimitOrOffset(query.get('limit'), DEFAULT_LIST_LIMIT),
      offset: listLimitOrOffset(query.get('offset'), 0),
    }),
  };
}

/** 读角色并裁决；不允许时给出该回的错误码。 */
async function authorize(
  db: D1Like,
  id: string,
  userId: string,
  action: Action,
): Promise<Failure | { ok: true; role: Role }> {
  const access = await findAccess(db, id, userId);
  const role = access === null
    ? null
    : resolveRole({ ownerId: access.ownerId, userId, memberRole: access.memberRole });
  const decision = decide(role, action);
  if (!decision.allow) return fail(decision.status === 404 ? ERROR_CODES.notFound : ERROR_CODES.forbidden);
  return { ok: true, role: role as Role };
}

/** GET /api/docs/:id：所有成员可读。 */
export async function getDocumentAction(
  db: D1Like,
  id: string,
  userId: string,
): Promise<{ ok: true; document: DocumentWithRole } | Failure> {
  const grant = await authorize(db, id, userId, 'read');
  if (!grant.ok) return grant;
  const document: Document | null = await getDocument(db, id);
  // 裁决后到读取前被软删：与不存在同码
  return document === null ? fail(ERROR_CODES.notFound) : { ok: true, document: { ...document, role: grant.role } };
}

/** PUT /api/docs/:id：owner / editor 可写；baseVersion 过期回 409 + 服务端当前文档。 */
export async function saveDocumentAction(
  db: D1Like,
  id: string,
  userId: string,
  body: unknown,
): Promise<{ ok: true; document: DocumentWithRole } | DocumentFailure> {
  if (!isRecord(body) || !Number.isInteger(body.baseVersion) || (body.baseVersion as number) < 1) {
    return fail(ERROR_CODES.invalidRequest);
  }
  const hasTitle = body.title !== undefined;
  const hasContent = body.content !== undefined;
  if ((!hasTitle && !hasContent) || (hasTitle && !validTitle(body.title)) || (hasContent && !validContent(body.content))) {
    return fail(ERROR_CODES.invalidRequest);
  }
  const grant = await authorize(db, id, userId, 'write');
  if (!grant.ok) return grant;
  const result = await updateDocument(db, {
    id,
    baseVersion: body.baseVersion as number,
    title: hasTitle ? (body.title as string) : undefined,
    content: hasContent ? (body.content as string) : undefined,
  });
  if (result.status === 'ok') return { ok: true, document: { ...result.document, role: grant.role } };
  if (result.status === 'conflict') {
    return { ok: false, code: ERROR_CODES.versionConflict, current: { ...result.current, role: grant.role } };
  }
  return fail(ERROR_CODES.notFound);
}

/** DELETE /api/docs/:id：owner 专属；软删。 */
export async function deleteDocumentAction(db: D1Like, id: string, userId: string): Promise<{ ok: true } | Failure> {
  const grant = await authorize(db, id, userId, 'delete');
  if (!grant.ok) return grant;
  // 裁决时还在、落库时已被删：对调用者与「不存在」无差别
  return (await softDeleteDocument(db, id)) ? { ok: true } : fail(ERROR_CODES.notFound);
}
