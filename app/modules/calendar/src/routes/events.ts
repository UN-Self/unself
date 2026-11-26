// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import { requireAuth, type AppEnv } from '../auth';
import { findEvent, findLatestActorName, insertChange, updateEventConditional } from '../events/store';
import { validatePatch } from '../events/validate';
import { rowToEvent } from '../types';

/** PATCH 顺序固定：验 token → 查记录（软删 404）→ 判组织者 → 校验 → 条件更新 → 写流水。先判组织者再校验，否则非组织者能从 400/409 的差别探出字段内容。 */

/** 21 位 URL-safe id，字符集与接口文档的 nanoid 口径一致。 */
function newChangeId(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** 409 统一体：当前 event、version 与最近改动人，前端据此显示撞车人。 */
async function conflict(c: Context<AppEnv>, event: ReturnType<typeof rowToEvent>): Promise<Response> {
  const actorName = await findLatestActorName(c.env.DB, event.id);
  return c.json({ error: 'version_conflict', event, version: event.version, actorName }, 409);
}

export async function patchEvent(c: Context<AppEnv>): Promise<Response> {  const blocked = await requireAuth(c);
  if (blocked) return blocked;
  const claims = c.get('claims');
  const id = c.req.param('id') ?? '';

  const row = await findEvent(c.env.DB, id);
  if (!row || row.deleted_at !== null) {
    return c.json({ error: 'not_found' }, 404);
  }
  if (row.organizer_id !== claims.sub) {
    return c.json({ error: 'forbidden' }, 403);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'body_must_be_json' }, 400);
  }

  const result = validatePatch(raw, row);
  if (!result.ok) {
    return result.field === undefined
      ? c.json({ error: result.error }, 400)
      : c.json({ error: result.error, field: result.field }, 400);
  }

  const before = rowToEvent(row);

  // 无字段变化时不写库不写流水；但版本已过期必须报 409，否则前端会把旧视图当成保存成功。
  if (result.changedFields.length === 0) {
    if (result.patch.version !== row.version) {
      const latest = (await findEvent(c.env.DB, id)) ?? row;
      return await conflict(c, rowToEvent(latest));
    }
    return c.json({ event: before, version: before.version });
  }

  const now = Date.now();
  const changed = await updateEventConditional(
    c.env.DB,
    row.id,
    result.patch.version,
    result.columns,
    now,
  );

  if (changed === 0) {
    // 版本对不上或已被删除：重新查一次区分 404 与 409
    const latest = await findEvent(c.env.DB, id);
    if (!latest || latest.deleted_at !== null) {
      return c.json({ error: 'not_found' }, 404);
    }
    const event = rowToEvent(latest);
    return await conflict(c, event);
  }

  // 变更记录是独立 INSERT：写失败也不影响主表正确性，只少一条提示记录
  try {
    await insertChange(
      c.env.DB,
      {
        id: newChangeId(),
        eventId: row.id,
        actorId: claims.sub,
        actorName: claims.name ?? claims.sub,
        fromVersion: before.version,
        toVersion: before.version + 1,
        changedFields: result.changedFields,
      },
      now,
    );
  } catch {
    // 有意留空：下一次修改会写入新的记录
  }

  const updated = await findEvent(c.env.DB, id);
  const event = updated
    ? rowToEvent(updated)
    : { ...result.next, version: before.version + 1, updatedAt: now };
  return c.json({ event, version: event.version });
}

/** 详情读接口：归模块自有，变更流只给 eventId，撞车对比要拿完整日程；软删一律 404，口径同 PATCH。 */
export async function getEvent(c: Context<AppEnv>): Promise<Response> {
  const blocked = await requireAuth(c);
  if (blocked) return blocked;
  const id = c.req.param('id') ?? '';

  const row = await findEvent(c.env.DB, id);
  if (!row || row.deleted_at !== null) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ event: rowToEvent(row) });
}
