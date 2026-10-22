// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { createCoreDb } from './test-factory';

describe('core D1 migration', () => {
  it('baseline seed can be reapplied while preserving notification types', () => {
    const db = createCoreDb();
    try {
      const baseline = fileURLToPath(new URL('../migrations/core/0001_init.sql', import.meta.url));
      expect(() => db.sqlite.exec(readFileSync(baseline, 'utf8'))).not.toThrow();
      expect(db.query<{ type: string }>('SELECT type FROM notification_types ORDER BY type')).toEqual([
        { type: 'account_ready' },
        { type: 'invite_pending' },
        { type: 'invite_result' },
        { type: 'module_notify' }, // #243：模块通知（站内渠道）
        { type: 'module_toggled' },
      ]);
    } finally {
      db.close();
    }
  });

  it('stores notifications for an invited email before a recipient user exists', () => {
    const db = createCoreDb();
    try {
      db.run(
        'INSERT INTO notifications (id, invited_email, type, payload) VALUES (?, ?, ?, ?)',
        'n_1',
        'alice@personal.example',
        'account_ready',
        '{}',
      );
      expect(
        db.first<{ user_id: string | null; invited_email: string; is_read: number }>(
          'SELECT user_id, invited_email, is_read FROM notifications WHERE id = ?',
          'n_1',
        ),
      ).toEqual({ user_id: null, invited_email: 'alice@personal.example', is_read: 0 });
    } finally {
      db.close();
    }
  });
});

/**
 * #340 0011 拆键：硬性走「存量老库升级」路径——只应用 0001-0010、种旧 `mail` 行后再跑 0011。
 * createCoreDb 是全量重放（全新库），测不到「旧数据在场时拆键」这一升级语义，不能只测它。
 */
function legacyCoreDb(): { sqlite: DatabaseSync; apply0011: () => void } {
  const dir = fileURLToPath(new URL('../migrations/core/', import.meta.url));
  const sqlite = new DatabaseSync(':memory:');
  const applied = readdirSync(dir)
    .map((file) => ({ file, prefix: /^(\d{4})_/.exec(file)?.[1] }))
    .filter(({ file, prefix }) => prefix !== undefined && Number(prefix) <= 10 && file.endsWith('.sql'))
    .sort((a, b) => a.file.localeCompare(b.file));
  for (const { file } of applied) {
    sqlite.exec(readFileSync(`${dir}/${file}`, 'utf8'));
  }
  const sql0011 = readFileSync(`${dir}/0011_split_mail_config.sql`, 'utf8');
  return {
    sqlite,
    apply0011: () => sqlite.exec(sql0011),
  };
}

/** 直读两行的落库原文（JSON 字符串原样，断言键值与布尔字面量）。 */
function splitRows(sqlite: DatabaseSync): { stalwart: string | null; smtp: string | null } {
  const stalwart = sqlite.prepare("SELECT value FROM instance_config WHERE key = 'mail_stalwart'").get() as
    | { value: string }
    | undefined;
  const smtp = sqlite.prepare("SELECT value FROM instance_config WHERE key = 'mail_smtp'").get() as
    | { value: string }
    | undefined;
  return { stalwart: stalwart?.value ?? null, smtp: smtp?.value ?? null };
}

describe('0011 拆键（老库 0001-0010 已应用 + 0011，#340）', () => {
  it('两侧字段齐（无 enabled 字段的老数据）→ 两行 enabled:true 缺省开，portalUrl 保留，只挑各自字段', () => {
    const { sqlite, apply0011 } = legacyCoreDb();
    try {
      sqlite
        .prepare('INSERT INTO instance_config (key, value) VALUES (?, ?)')
        .run(
          'mail',
          JSON.stringify({
            baseUrl: 'https://mail.example.com',
            apiKey: 'k',
            domain: 'example.com',
            portalUrl: 'https://portal.example.com',
            host: 'smtp.example.com',
            port: 465,
            username: 'bot',
            password: 'secret',
            from: 'noreply@example.com',
          }),
        );

      apply0011();

      const { stalwart, smtp } = splitRows(sqlite);
      expect(JSON.parse(stalwart!)).toEqual({
        enabled: true,
        baseUrl: 'https://mail.example.com',
        apiKey: 'k',
        domain: 'example.com',
        portalUrl: 'https://portal.example.com',
      });
      expect(JSON.parse(smtp!)).toEqual({
        enabled: true,
        host: 'smtp.example.com',
        port: 465,
        username: 'bot',
        password: 'secret',
        from: 'noreply@example.com',
      });
      // JSON 布尔字面量（D5 硬要求）：数字 1/0 在 JS 里 !== true/false，读侧 enabled === true 会翻车。
      expect(stalwart).toContain('"enabled":true');
      expect(smtp).toContain('"enabled":true');
    } finally {
      sqlite.close();
    }
  });

  it('仅 stalwart 侧字段（无任何 smtp 字段）→ 只落 mail_stalwart 行，mail_smtp 不写行', () => {
    const { sqlite, apply0011 } = legacyCoreDb();
    try {
      sqlite
        .prepare('INSERT INTO instance_config (key, value) VALUES (?, ?)')
        .run('mail', JSON.stringify({ baseUrl: 'https://mail.example.com', apiKey: 'k', domain: 'example.com' }));

      apply0011();

      const { stalwart, smtp } = splitRows(sqlite);
      expect(JSON.parse(stalwart!)).toEqual({ enabled: true, baseUrl: 'https://mail.example.com', apiKey: 'k', domain: 'example.com' });
      expect(smtp).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it('仅 smtp 侧字段（无任何 stalwart 字段）→ 只落 mail_smtp 行，mail_stalwart 不写行', () => {
    const { sqlite, apply0011 } = legacyCoreDb();
    try {
      sqlite
        .prepare('INSERT INTO instance_config (key, value) VALUES (?, ?)')
        .run('mail', JSON.stringify({ host: 'smtp.example.com', port: 465, username: 'bot', password: 'secret', from: 'noreply@example.com' }));

      apply0011();

      const { stalwart, smtp } = splitRows(sqlite);
      expect(stalwart).toBeNull();
      expect(JSON.parse(smtp!)).toEqual({ enabled: true, host: 'smtp.example.com', port: 465, username: 'bot', password: 'secret', from: 'noreply@example.com' });
    } finally {
      sqlite.close();
    }
  });

  it('旧 enabled:false + 两侧字段齐 → 两行 enabled:false 字段照抄；旧 mail 行保留不删（D2 回滚兼容）', () => {
    const { sqlite, apply0011 } = legacyCoreDb();
    try {
      const old = JSON.stringify({
        enabled: false,
        baseUrl: 'https://mail.example.com',
        apiKey: 'k',
        domain: 'example.com',
        host: 'smtp.example.com',
        port: 465,
        username: 'bot',
        password: 'secret',
        from: 'noreply@example.com',
      });
      sqlite.prepare('INSERT INTO instance_config (key, value) VALUES (?, ?)').run('mail', old);

      apply0011();

      const { stalwart, smtp } = splitRows(sqlite);
      expect(stalwart).toContain('"enabled":false');
      expect(smtp).toContain('"enabled":false');
      expect(JSON.parse(stalwart!)).toMatchObject({ baseUrl: 'https://mail.example.com', apiKey: 'k', domain: 'example.com' });
      expect(JSON.parse(smtp!)).toMatchObject({ host: 'smtp.example.com', port: 465, from: 'noreply@example.com' });
      // 旧行原样保留：回滚到旧版本代码仍读得到完整配置。
      expect(sqlite.prepare("SELECT value FROM instance_config WHERE key = 'mail'").get()).toEqual({ value: old });
    } finally {
      sqlite.close();
    }
  });

  it('半配置（旧值开但侧字段不全）→ 落行但 enabled=false，只抄在场字段；空对象 / 损坏 JSON → 零行', () => {
    const { sqlite, apply0011 } = legacyCoreDb();
    try {
      // 半配置：stalwart 只有 domain（缺 baseUrl/apiKey）；smtp 只有 host+username。
      sqlite
        .prepare('INSERT INTO instance_config (key, value) VALUES (?, ?)')
        .run('mail', JSON.stringify({ domain: 'example.com', host: 'smtp.example.com', username: 'bot' }));

      apply0011();

      const { stalwart, smtp } = splitRows(sqlite);
      expect(JSON.parse(stalwart!)).toEqual({ enabled: false, domain: 'example.com' });
      expect(stalwart).toContain('"enabled":false');
      expect(JSON.parse(smtp!)).toEqual({ enabled: false, host: 'smtp.example.com', username: 'bot' });

      // 空对象：两侧全空 → 零行。
      sqlite.prepare('DELETE FROM instance_config').run();
      sqlite.prepare('INSERT INTO instance_config (key, value) VALUES (?, ?)').run('mail', '{}');
      apply0011();
      expect(splitRows(sqlite)).toEqual({ stalwart: null, smtp: null });

      // 损坏 JSON：不抛错、零行（升级不因脏数据中断）。
      sqlite.prepare('DELETE FROM instance_config').run();
      sqlite.prepare('INSERT INTO instance_config (key, value) VALUES (?, ?)').run('mail', '{broken');
      expect(() => apply0011()).not.toThrow();
      expect(splitRows(sqlite)).toEqual({ stalwart: null, smtp: null });
    } finally {
      sqlite.close();
    }
  });

  it('脏数据边界：JSON null 的 portalUrl 不算字段（不凭空建段）；字符串端口按数字收下', () => {
    const { sqlite, apply0011 } = legacyCoreDb();
    try {
      // portalUrl 为 JSON null：既不是「在场字段」，也不该被抄成 "portalUrl":null。
      sqlite
        .prepare('INSERT INTO instance_config (key, value) VALUES (?, ?)')
        .run('mail', JSON.stringify({ portalUrl: null, enabled: false }));
      apply0011();
      expect(splitRows(sqlite)).toEqual({ stalwart: null, smtp: null });

      // 历史/手工数据的字符串端口：不该丢 port、更不该因类型不符把发信轴静默关掉。
      sqlite.prepare('DELETE FROM instance_config').run();
      sqlite
        .prepare('INSERT INTO instance_config (key, value) VALUES (?, ?)')
        .run(
          'mail',
          JSON.stringify({
            host: 'smtp.example.com',
            port: '465',
            username: 'bot',
            password: 'secret',
            from: 'noreply@example.com',
          }),
        );
      apply0011();
      const { smtp } = splitRows(sqlite);
      expect(JSON.parse(smtp!)).toEqual({
        enabled: true,
        host: 'smtp.example.com',
        port: 465,
        username: 'bot',
        password: 'secret',
        from: 'noreply@example.com',
      });
      expect(smtp).toContain('"port":465');
    } finally {
      sqlite.close();
    }
  });

  it('幂等：完整场景重复应用 0011 → 行不重复、值不变', () => {
    const { sqlite, apply0011 } = legacyCoreDb();
    try {
      sqlite
        .prepare('INSERT INTO instance_config (key, value) VALUES (?, ?)')
        .run(
          'mail',
          JSON.stringify({
            baseUrl: 'https://mail.example.com',
            apiKey: 'k',
            domain: 'example.com',
            host: 'smtp.example.com',
            port: 465,
            username: 'bot',
            password: 'secret',
            from: 'noreply@example.com',
          }),
        );

      apply0011();
      const first = splitRows(sqlite);
      apply0011();
      const second = splitRows(sqlite);

      expect(second).toEqual(first);
      expect(JSON.parse(second.stalwart!)).toEqual({
        enabled: true,
        baseUrl: 'https://mail.example.com',
        apiKey: 'k',
        domain: 'example.com',
      });
    } finally {
      sqlite.close();
    }
  });
});
