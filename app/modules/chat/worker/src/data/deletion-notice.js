// SPDX-License-Identifier: AGPL-3.0-only
export function mapDeletionNotice(row) {
  if (!row.deletion_actor_id) return undefined;
  return {
    actorId: Number(row.deletion_actor_id),
    actorName: row.deletion_actor_name || '已注销用户',
    action: Number(row.deletion_actor_id) === Number(row.sender_id) ? 'recalled' : 'removed',
  };
}
export async function getDeletionNotice(db, messageId) {
  const row = await db.prepare(`SELECT a.actor_user_id AS deletion_actor_id,
    u.display_name AS deletion_actor_name, m.sender_id
    FROM message_deletion_audit a JOIN messages m ON m.id = a.message_id
    LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.message_id = ? ORDER BY a.id LIMIT 1`)
    .bind(Number(messageId)).first();
  return row ? mapDeletionNotice(row) : undefined;
}
