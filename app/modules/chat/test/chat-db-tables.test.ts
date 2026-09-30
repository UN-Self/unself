// SPDX-License-Identifier: AGPL-3.0-only
// @ts-nocheck —— 直接测未加类型的 worker 源码（db-tables.js / files-s3.js），类型由运行时行为保障
import { describe, expect, it } from 'vitest';
import { applyTablePrefix, CHAT_TABLES } from '../worker/src/db-tables.js';

const PREFIX = 'chat_';

function createFakeDb() {
  const calls = { prepare: [], exec: [], batch: [] };
  const db = {
    prepare(sql) {
      calls.prepare.push(sql);
      return { __source: 'original', sql };
    },
    exec(sql) {
      calls.exec.push(sql);
      return { count: 0, duration: 0 };
    },
    batch(statements) {
      calls.batch.push(statements);
      return Promise.resolve(statements.map(() => ({ success: true })));
    }
  };
  return { db, calls };
}

function prepareSql(sql, prefix = PREFIX) {
  const { db, calls } = createFakeDb();
  applyTablePrefix(db, prefix).prepare(sql);
  return calls.prepare[0];
}

describe('CHAT_TABLES', () => {
  it('与 manifest.yaml tables 一一对应（18 个逻辑表名，顺序一致）', () => {
    expect(CHAT_TABLES).toEqual([
      'users',
      'channels',
      'channel_members',
      'messages',
      'user_blocks',
      'channel_pins',
      'message_reads',
      'site_settings',
      'registration_invites',
      'registration_invite_uses',
      'uploaded_files',
      'device_sessions',
      'realtime_tickets',
      'message_events',
      'message_event_compaction',
      'pending_r2_delete',
      'core_identities',
      'read_receipts'
    ]);
  });
});

describe('applyTablePrefix SQL 重写', () => {
  it('把裸表名替换为前缀表名', () => {
    expect(prepareSql('SELECT * FROM users WHERE id=?')).toBe(
      'SELECT * FROM chat_users WHERE id=?'
    );
  });

  it('REFERENCES / UPDATE / INSERT INTO 同样替换', () => {
    expect(prepareSql('REFERENCES messages')).toBe('REFERENCES chat_messages');
    expect(prepareSql('UPDATE channels SET name = ?')).toBe(
      'UPDATE chat_channels SET name = ?'
    );
    expect(prepareSql('INSERT INTO uploaded_files (key) VALUES (?)\n')).toBe(
      'INSERT INTO chat_uploaded_files (key) VALUES (?)\n'
    );
  });

  it('全部 18 个逻辑表名都会被加上前缀', () => {
    for (const table of CHAT_TABLES) {
      expect(prepareSql(`SELECT * FROM ${table}`)).toBe(
        `SELECT * FROM chat_${table}`
      );
    }
  });

  it('长名优先：message_events 与 message_event_compaction 互不误伤', () => {
    expect(prepareSql('FROM message_event_compaction')).toBe(
      'FROM chat_message_event_compaction'
    );
    expect(prepareSql('FROM message_events')).toBe('FROM chat_message_events');
  });
});

describe('applyTablePrefix 跳过字符串字面量', () => {
  it('单引号字符串里的表名原样保留，只替换真实表引用', () => {
    const sql =
      "WHERE type = 'read_receipts' AND user_id IN (SELECT id FROM users)";
    expect(prepareSql(sql)).toBe(
      "WHERE type = 'read_receipts' AND user_id IN (SELECT id FROM chat_users)"
    );
  });

  it('协议字符串字面量 read_receipts 不受影响（ChannelRoom 实证）', () => {
    const sql = "json_extract(meta, '$.type') = 'read_receipts' FROM read_receipts";
    expect(prepareSql(sql)).toBe(
      "json_extract(meta, '$.type') = 'read_receipts' FROM chat_read_receipts"
    );
  });

  it("字符串里的转义单引号（两个连续单引号）不会提前结束字面量", () => {
    const sql = "SELECT * FROM users WHERE name = 'it''s users'";
    expect(prepareSql(sql)).toBe(
      "SELECT * FROM chat_users WHERE name = 'it''s users'"
    );
  });
});

describe('applyTablePrefix 不误伤部分匹配', () => {
  it('userId / users_extra / 已带前缀的 chat_users 不被二次加前缀', () => {
    const sql = 'SELECT userId, users_extra, chat_users FROM users';
    expect(prepareSql(sql)).toBe(
      'SELECT userId, users_extra, chat_users FROM chat_users'
    );
  });

  it('已带前缀的表名在任何位置都保持原样', () => {
    expect(prepareSql('SELECT * FROM chat_channels JOIN chat_messages')).toBe(
      'SELECT * FROM chat_channels JOIN chat_messages'
    );
  });
});

describe('applyTablePrefix 空前缀恒等', () => {
  it('prefix 为空/falsy 时直接返回原 db', () => {
    const { db } = createFakeDb();
    expect(applyTablePrefix(db, '')).toBe(db);
    expect(applyTablePrefix(db, undefined)).toBe(db);
    expect(applyTablePrefix(db, null)).toBe(db);
    expect(applyTablePrefix(db, '')).toBe(db);
  });

  it('空前缀下 prepare 行为与原 db 完全一致', () => {
    const { db, calls } = createFakeDb();
    const wrapped = applyTablePrefix(db, '');
    const stmt = wrapped.prepare('SELECT * FROM users');
    expect(calls.prepare).toEqual(['SELECT * FROM users']);
    expect(stmt.__source).toBe('original');
  });
});

describe('applyTablePrefix 委托原 db', () => {
  it('prepare/exec 用重写后的 SQL 调用原 db，返回原 db 的结果', () => {
    const { db, calls } = createFakeDb();
    const wrapped = applyTablePrefix(db, PREFIX);

    const stmt = wrapped.prepare('SELECT * FROM users WHERE id=?');
    expect(calls.prepare).toEqual(['SELECT * FROM chat_users WHERE id=?']);
    expect(stmt).toEqual({ __source: 'original', sql: 'SELECT * FROM chat_users WHERE id=?' });

    const execResult = wrapped.exec('DELETE FROM messages');
    expect(calls.exec).toEqual(['DELETE FROM chat_messages']);
    expect(execResult).toEqual({ count: 0, duration: 0 });
  });

  it('batch 直接委托，语句在 prepare 处已重写', () => {
    const { db, calls } = createFakeDb();
    const wrapped = applyTablePrefix(db, PREFIX);

    const statements = [
      wrapped.prepare('SELECT * FROM users'),
      wrapped.prepare('SELECT * FROM channels')
    ];
    wrapped.batch(statements);

    expect(calls.batch).toHaveLength(1);
    expect(calls.batch[0]).toBe(statements);
    expect(calls.batch[0].map((stmt) => stmt.sql)).toEqual([
      'SELECT * FROM chat_users',
      'SELECT * FROM chat_channels'
    ]);
  });

  it('未覆盖的绑定成员透传', () => {
    const { db } = createFakeDb();
    const wrapped = applyTablePrefix(db, PREFIX);
    expect(wrapped.prepare).toBeTypeOf('function');
    expect(wrapped.someFutureBinding).toBeUndefined();

    db.dump = () => 'dump';
    expect(wrapped.dump()).toBe('dump');
  });
});
