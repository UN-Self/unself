// SPDX-License-Identifier: AGPL-3.0-only

/** 记审计（部署/管理员动作留痕，§6.5 异常排查）。只写 audit_log 表，不跨域。 */
export async function audit(db: D1Database, actor: string, action: string, target?: string): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (actor, action, target) VALUES (?, ?, ?)')
    .bind(actor, action, target ?? null)
    .run();
}
