// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 文档仓储层（#358 T2）：docs_documents 的创建 / 查询 / 列表 / 更新 / 软删除。
 *
 * 并发口径（§5）：保存必须带 baseVersion，落库是单条
 * `UPDATE ... WHERE id = ? AND version = ? AND deleted_at IS NULL`；
 * 影响 0 行即「版本过期」或「已被软删」——前者把服务端当前内容一并回给调用方（409 体）。
 * 不读后写、不开事务：D1 单写者 + 单语句原子性足够，版本号在 UPDATE 内自增，天然严格递增。
 *
 * 软删语义：deleted_at 非空即不可见（查询/列表/更新都带 `deleted_at IS NULL`）。
 * 仓储层只负责数据，不做鉴权——非成员 404 由 documents.ts 在调用本层之前裁决（角色值由 findAccess 读出）。
 *
 * 类型依赖：D1 的最小结构化类型在 ../d1.ts（与迁移执行器共用），
 * 真实 D1Database / D1PreparedStatement 结构兼容，可直接传。
 */
import type { D1Like } from '../d1';
import type { Role } from '../auth/policy';

/** 落库行（snake_case，与基线迁移列名一一对应）。 */
export interface DocumentRow {
  id: string;
  title: string;
  content: string;
  owner_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** 对外形状（camelCase）：REST 层直接 JSON 化，不把列名泄漏给前端。 */
export interface Document {
  id: string;
  title: string;
  content: string;
  ownerId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

const DOCUMENT_COLUMNS = ['id', 'title', 'content', 'owner_id', 'version', 'created_at', 'updated_at', 'deleted_at'] as const;
const DOCUMENT_COLUMNS_SQL = DOCUMENT_COLUMNS.join(', ');

function toDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    ownerId: row.owner_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function toDocumentWithRole(row: DocumentRow & { role: Role }): DocumentWithRole {
  return { ...toDocument(row), role: row.role };
}

export interface CreateDocumentInput {
  ownerId: string;
  title: string;
  content?: string;
  /** 仅测试/导入用；正常路径由仓储层生成。 */
  id?: string;
}

/** 创建文档：版本从 1 起，owner 只写 owner_id（成员表不落 owner 行）。 */
export async function createDocument(db: D1Like, input: CreateDocumentInput): Promise<Document> {
  const id = input.id ?? `d_${crypto.randomUUID().replace(/-/g, '')}`;
  const row = await db
    .prepare(
      `INSERT INTO docs_documents (id, title, content, owner_id)
       VALUES (?, ?, ?, ?)
       RETURNING ${DOCUMENT_COLUMNS_SQL}`,
    )
    .bind(id, input.title, input.content ?? '', input.ownerId)
    .first<DocumentRow>();
  if (row === null) {
    throw new Error('createDocument: INSERT RETURNING 没有回行');
  }
  return toDocument(row);
}

/** 按 id 取未删文档；不存在或已软删统一 null（调用方回 404，不泄露存在性）。 */
export async function getDocument(db: D1Like, id: string): Promise<Document | null> {
  const row = await db
    .prepare(`SELECT ${DOCUMENT_COLUMNS_SQL} FROM docs_documents WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<DocumentRow>();
  return row === null ? null : toDocument(row);
}

/** 调用者相对某份文档的身份：owner 命中即 owner，否则看成员表取值（交给 resolveRole 裁决）。 */
export interface DocumentAccess {
  ownerId: string;
  memberRole: string | null;
}

/**
 * 读裁决要的两个值（#358 §5）。文档不存在或已软删统一 null（调用方回 404，不泄露存在性）。
 * 成员行按「这份文档 + 这个用户」左连，一次查询拿齐，不读整份文档内容。
 */
export async function findAccess(db: D1Like, id: string, userId: string): Promise<DocumentAccess | null> {
  const row = await db
    .prepare(
      `SELECT d.owner_id, m.role AS member_role
         FROM docs_documents d
         LEFT JOIN docs_document_members m ON m.doc_id = d.id AND m.user_id = ?
        WHERE d.id = ? AND d.deleted_at IS NULL`,
    )
    .bind(userId, id)
    .first<Pick<DocumentRow, 'owner_id'> & { member_role: string | null }>();
  return row === null ? null : { ownerId: row.owner_id, memberRole: row.member_role };
}

/** 对外文档形状 + 调用者的角色（前端按它决定删除按钮、只读态；权限仍由服务端裁决）。 */
export type DocumentWithRole = Document & { role: Role };

export interface ListDocumentsOptions {
  limit?: number;
  offset?: number;
}

export interface DocumentPage {
  items: DocumentWithRole[];
  /** 排在 limit 之外还有没有下一条：多取一条探测，前端不用猜「满页 = 还有」。 */
  hasMore: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * 列表：我拥有的 + 我被共享的，未删、按 updated_at 倒序，offset 分页。
 * 每行带调用者的角色：owner_id 命中是 owner（owner 优先于成员表里的残留行），否则取成员表的角色。
 * 注意：这里的 m.role 直信库值、不走 resolveRole 的 fail-closed——成员表的
 * CHECK (role IN ('editor','viewer'))（0001_baseline.sql）在库层挡住了脏值；
 * 将来若放宽该约束，此处必须改走 resolveRole。
 * limit 收口在 1..100 防止前端一次拉全库。
 */
export async function listDocuments(
  db: D1Like,
  userId: string,
  options: ListDocumentsOptions = {},
): Promise<DocumentPage> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const { results } = await db
    .prepare(
      `SELECT ${DOCUMENT_COLUMNS.map((column) => `d.${column}`).join(', ')},
              CASE WHEN d.owner_id = ? THEN 'owner' ELSE m.role END AS role
         FROM docs_documents d
         LEFT JOIN docs_document_members m ON m.doc_id = d.id AND m.user_id = ?
        WHERE d.deleted_at IS NULL
          AND (d.owner_id = ? OR m.doc_id IS NOT NULL)
        ORDER BY d.updated_at DESC, d.id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(userId, userId, userId, limit + 1, offset)
    .all<DocumentRow & { role: Role }>();
  return {
    items: results.slice(0, limit).map(toDocumentWithRole),
    hasMore: results.length > limit,
  };
}

export interface UpdateDocumentInput {
  id: string;
  /** 前端读到的版本号；与服务端不一致即冲突。 */
  baseVersion: number;
  title?: string;
  content?: string;
}

/**
 * 更新结果：
 * - ok：成功，返回自增后的新版本
 * - conflict：版本过期，附服务端当前内容（409 响应体，前端给「覆盖 / 重载 / 取消」）
 * - not_found：文档不存在或已软删
 */
export type UpdateDocumentResult =
  | { status: 'ok'; document: Document }
  | { status: 'conflict'; current: Document }
  | { status: 'not_found' };

/**
 * 保存：单条原子 UPDATE + version 守卫。
 * title/content 用 COALESCE 表达「本次没传就保留原值」，避免拼接动态 SQL。
 */
export async function updateDocument(db: D1Like, input: UpdateDocumentInput): Promise<UpdateDocumentResult> {
  const row = await db
    .prepare(
      `UPDATE docs_documents
          SET title = COALESCE(?, title),
              content = COALESCE(?, content),
              version = version + 1,
              updated_at = datetime('now')
        WHERE id = ? AND version = ? AND deleted_at IS NULL
        RETURNING ${DOCUMENT_COLUMNS_SQL}`,
    )
    .bind(input.title ?? null, input.content ?? null, input.id, input.baseVersion)
    .first<DocumentRow>();
  if (row !== null) {
    return { status: 'ok', document: toDocument(row) };
  }

  const current = await db
    .prepare(`SELECT ${DOCUMENT_COLUMNS_SQL} FROM docs_documents WHERE id = ? AND deleted_at IS NULL`)
    .bind(input.id)
    .first<DocumentRow>();
  return current === null
    ? { status: 'not_found' }
    : { status: 'conflict', current: toDocument(current) };
}

/** 软删：只打 deleted_at，行保留；重复删除返回 false（幂等，不报错）。 */
export async function softDeleteDocument(db: D1Like, id: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE docs_documents SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
