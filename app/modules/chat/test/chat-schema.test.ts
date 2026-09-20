// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { createChatDb, type ChatTestDb } from './chat-test-factory';

/**
 * schema 基线守护：真 SQLite 加载 migrations/chat/0001_baseline.sql 后，
 * 关键表存在、messages 关键列在位——SQL 与建表列错位当场红（#60 教训）。
 * 另断言 telegram 时代残留表不存在（M2 清库遗留）。
 */
function freshDb(): ChatTestDb {
  return createChatDb();
}

describe('chat schema 基线', () => {
  it('关键表存在：users/channels/channel_members/messages', () => {
    const db = freshDb();
    const tables = db
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((row) => row.name);
    for (const table of ['users', 'channels', 'channel_members', 'messages']) {
      expect(tables).toContain(table);
    }
    db.close();
  });

  it('messages 表含 mention_user_ids / reply_to_message_id / attachment_kind 列', () => {
    const db = freshDb();
    const columns = db.columns('messages');
    expect(columns).toContain('mention_user_ids');
    expect(columns).toContain('reply_to_message_id');
    expect(columns).toContain('attachment_kind');
    db.close();
  });

  it('telegram 残留表不存在（sqlite_master 查 telegram%）', () => {
    const db = freshDb();
    const leftovers = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name LIKE 'telegram%'",
    );
    expect(leftovers).toEqual([]);
    db.close();
  });
});
