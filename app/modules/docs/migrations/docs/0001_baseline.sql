-- SPDX-License-Identifier: AGPL-3.0-only
-- 文档模块（docs）CORE_DB 基线表结构（#358 §5）
--
-- 幂等硬约束：迁移按文件名记账、逐条执行且没有 BEGIN/COMMIT，任何一条失败都会整份重放，
-- 所以 CREATE TABLE/INDEX 一律 IF NOT EXISTS（docs/modules.md §6）。
-- 表名统一 docs_ 前缀；禁止跨模块外键：owner_id / author_id 是 core 的用户 id，
-- 不建指向其他模块表的约束。模块内部（成员/评论 → 文档）保留外键。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS docs_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

-- 成员表：owner 不落行，由 docs_documents.owner_id 判定；这里只存 editor / viewer。
CREATE TABLE IF NOT EXISTS docs_document_members (
  doc_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  PRIMARY KEY (doc_id, user_id),
  FOREIGN KEY (doc_id) REFERENCES docs_documents(id)
);

CREATE TABLE IF NOT EXISTS docs_document_comments (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES docs_documents(id)
);

-- 我拥有的文档（列表按 updated_at 倒序，deleted_at 参与过滤）。
CREATE INDEX IF NOT EXISTS idx_docs_documents_owner ON docs_documents (owner_id, deleted_at);
-- 列表主扫描：未删行按更新时间倒序。
CREATE INDEX IF NOT EXISTS idx_docs_documents_updated ON docs_documents (deleted_at, updated_at);
-- 共享给我的文档：PK(doc_id, user_id) 只覆盖按 doc 查成员，反向要单独索引。
CREATE INDEX IF NOT EXISTS idx_docs_document_members_user ON docs_document_members (user_id);
-- 评论侧栏按文档取时间线。
CREATE INDEX IF NOT EXISTS idx_docs_document_comments_doc ON docs_document_comments (doc_id, created_at);
