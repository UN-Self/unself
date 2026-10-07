// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
