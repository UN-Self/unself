// SPDX-License-Identifier: AGPL-3.0-only
import { DatabaseSync } from 'node:sqlite';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
} from 'jose';

import {
  CALENDAR_MIGRATIONS_DIR,
  applyMigrations,
  createD1Adapter,
} from './calendar-d1.ts';

/** 测试工厂：真 SQLite + 真迁移 + 最小 D1 适配器（适配器见 calendar-d1.ts，不用假 D1）。 */

/** 测试里绑定的参数类型（node:sqlite 的 SQLInputValue 常用子集）。 */
type Bindable = string | number | null;

export interface CalendarTestDb {
  /** 传给 app.request(..., env) 的 DB 绑定。 */
  d1: D1Database;
  sqlite: DatabaseSync;
  /** 直查真库（断言真实行，不经适配器）。 */
  query<T = Record<string, unknown>>(sql: string, ...params: Bindable[]): T[];
  first<T = Record<string, unknown>>(sql: string, ...params: Bindable[]): T | null;
  run(sql: string, ...params: Bindable[]): { changes: number };
  close(): void;
}

export function createCalendarDb(): CalendarTestDb {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite, CALENDAR_MIGRATIONS_DIR);
  const d1 = createD1Adapter(sqlite);
  return {
    d1,
    sqlite,
    query<T = Record<string, unknown>>(sql: string, ...params: Bindable[]): T[] {
      return sqlite.prepare(sql).all(...params).map((row) => ({ ...row })) as T[];
    },
    first<T = Record<string, unknown>>(sql: string, ...params: Bindable[]): T | null {
      const row = sqlite.prepare(sql).get(...params);
      return row === undefined ? null : ({ ...row } as T);
    },
    run(sql: string, ...params: Bindable[]): { changes: number } {
      const result = sqlite.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    },
    close(): void {
      sqlite.close();
    },
  };
}

/** 种子日程：只给必要字段，其余按契约默认值走。 */
export interface SeedEventOptions {
  id?: string;
  organizerId?: string;
  title?: string;
  startAt?: number;
  endAt?: number;
  version?: number;
  deletedAt?: number | null;
  timezone?: string;
  description?: string | null;
  location?: string | null;
  status?: string;
}

export function seedEvent(db: CalendarTestDb, options: SeedEventOptions = {}): string {
  const id = options.id ?? 'evt_1';
  const now = 1_700_000_000_000;
  db.run(
    `INSERT INTO calendar_events
      (id, uid, title, description, location, start_at, end_at, all_day, timezone,
       organizer_id, response_state, rrule, status, version, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'accepted', NULL, ?, ?, ?, ?, ?)`,
    id,
    `uid-${id}`,
    options.title ?? '周会',
    options.description ?? null,
    options.location ?? 'E教 410',
    options.startAt ?? now,
    options.endAt ?? now + 3_600_000,
    options.timezone ?? 'Asia/Shanghai',
    options.organizerId ?? 'u_a',
    options.status ?? 'confirmed',
    options.version ?? 3,
    1_700_000_000_001,
    1_700_000_000_001,
    options.deletedAt ?? null,
  );
  return id;
}

/** 种子变更流水（用于同一毫秒多条这类只能靠直插构造的用例）。 */
export function seedChange(
  db: CalendarTestDb,
  options: {
    id: string;
    eventId: string;
    actorName?: string;
    toVersion?: number;
    changedFields?: string[];
    createdAt: number;
  },
): void {
  db.run(
    `INSERT INTO calendar_event_changes
      (id, event_id, actor_id, actor_name, from_version, to_version, changed_fields, created_at)
     VALUES (?, ?, 'u_b', ?, ?, ?, ?, ?)`,
    options.id,
    options.eventId,
    options.actorName ?? '黄二',
    (options.toVersion ?? 2) - 1,
    options.toVersion ?? 2,
    JSON.stringify(options.changedFields ?? ['title']),
    options.createdAt,
  );
}

/** 签发侧：每用例一把 ES256 密钥，公钥按 JWKS 注入 env；aud 固定 calendar，不能跨模块重放。 */
export interface MintSetup {
  makeToken: (overrides?: Record<string, unknown>, expOffset?: number) => Promise<string>;
  signWithForeignKey: () => Promise<string>;
}

export async function mintSetup(env: Record<string, unknown>): Promise<MintSetup> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  env.CORE_JWKS_JSON = JSON.stringify({
    keys: [{ ...publicJwk, kid, use: 'sig', alg: 'ES256' }],
  });

  const makeToken = async (
    overrides: Record<string, unknown> = {},
    expOffset?: number,
  ): Promise<string> => {
    const jwt = new SignJWT({
      iss: 'unself-core',
      sub: 'u_a',
      aud: 'calendar',
      name: '黄一',
      ...overrides,
    })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuedAt();
    if (expOffset === undefined) {
      jwt.setExpirationTime('10m');
    } else {
      jwt.setExpirationTime(Math.floor(Date.now() / 1000) + expOffset);
    }
    return jwt.sign(pair.privateKey);
  };

  const foreign = await generateKeyPair('ES256', { extractable: true });
  const signWithForeignKey = async (): Promise<string> =>
    new SignJWT({ iss: 'unself-core', sub: 'u_a', aud: 'calendar', name: '黄一' })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(foreign.privateKey as unknown as CryptoKey);

  return { makeToken, signWithForeignKey };
}

export const authHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});
