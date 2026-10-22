// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 邮件配置读侧行为测试（#340 mail-config.ts）：真 SQLite + 真迁移。
 * 口径：enabled 恒为显式布尔、缺省关（fail-closed）；旧 `mail` 键零读取（D2）；
 * /api/me 只看 mail_stalwart 段。断言打在行为上（HTTP 响应 / 注入工厂是否被装配 /
 * 是否抛错），改坏读侧语义必红。
 */
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { createSessionToken } from '../src/session';
import { isMailEnabled, configuredMailProvisioner, configuredMailSender, readMailAccess } from '../src/services/mail-config';
import { createCoreDb } from './test-factory';

/** 完整两段（0011 迁移/设置路由写入后的标准形状）。 */
const STALWART_SECTION = { enabled: true, baseUrl: 'https://mail.example.com', apiKey: 'k', domain: 'example.com' };
const SMTP_SECTION = { enabled: true, host: 'smtp.example.com', port: 465, username: 'u', password: 'p', from: 'no-reply@example.com' };

describe('装配判定 enabled === true 不变量（fail-closed，#340 D5）', () => {
  it('无段 → 双轴都不装配（工厂零调用），isMailEnabled=false', async () => {
    const db = createCoreDb();
    const provisionerFactory = vi.fn(() => {
      throw new Error('provisioner must stay unconstructed');
    });
    const senderFactory = vi.fn(() => null);

    expect(await isMailEnabled(db.d1)).toBe(false);
    expect(await configuredMailProvisioner(db.d1, provisionerFactory)).toBeNull();
    expect(await configuredMailSender(db.d1, senderFactory)).toBeNull();
    expect(provisionerFactory).not.toHaveBeenCalled();
    expect(senderFactory).not.toHaveBeenCalled();
  });

  it('enabled:false（字段齐全）→ 双轴都不装配，工厂零调用（关 ≠ 删行）', async () => {
    const db = createCoreDb();
    db.run(
      "INSERT INTO instance_config (key, value) VALUES ('mail_stalwart', ?)",
      JSON.stringify({ ...STALWART_SECTION, enabled: false }),
    );
    db.run(
      "INSERT INTO instance_config (key, value) VALUES ('mail_smtp', ?)",
      JSON.stringify({ ...SMTP_SECTION, enabled: false }),
    );
    const provisionerFactory = vi.fn(() => {
      throw new Error('provisioner must stay unconstructed');
    });
    const senderFactory = vi.fn(() => null);

    expect(await configuredMailProvisioner(db.d1, provisionerFactory)).toBeNull();
    expect(await configuredMailSender(db.d1, senderFactory)).toBeNull();
    expect(provisionerFactory).not.toHaveBeenCalled();
    expect(senderFactory).not.toHaveBeenCalled();
  });

  it('enabled 缺失的老形状 = 关（不再沿用 !== false 的缺省开）', async () => {
    const db = createCoreDb();
    const { enabled: _stalwartEnabled, ...stalwartBare } = STALWART_SECTION;
    const { enabled: _smtpEnabled, ...smtpBare } = SMTP_SECTION;
    db.run("INSERT INTO instance_config (key, value) VALUES ('mail_stalwart', ?)", JSON.stringify(stalwartBare));
    db.run("INSERT INTO instance_config (key, value) VALUES ('mail_smtp', ?)", JSON.stringify(smtpBare));
    const provisionerFactory = vi.fn(() => {
      throw new Error('provisioner must stay unconstructed');
    });
    const senderFactory = vi.fn(() => null);

    expect(await isMailEnabled(db.d1)).toBe(false);
    expect(await configuredMailProvisioner(db.d1, provisionerFactory)).toBeNull();
    expect(await configuredMailSender(db.d1, senderFactory)).toBeNull();
    expect(provisionerFactory).not.toHaveBeenCalled();
    expect(senderFactory).not.toHaveBeenCalled();
  });

  it('残缺但 enabled:true 的防御读取：不抛错；provisioner 照常构造（工厂自校验），sender 由装配器判字段回 null', async () => {
    const db = createCoreDb();
    db.run("INSERT INTO instance_config (key, value) VALUES ('mail_stalwart', ?)", JSON.stringify({ enabled: true }));
    db.run("INSERT INTO instance_config (key, value) VALUES ('mail_smtp', ?)", JSON.stringify({ enabled: true, host: 'smtp.example.com' }));

    const sentinel = { marker: true } as never;
    const provisionerFactory = vi.fn(() => sentinel);
    expect(await configuredMailProvisioner(db.d1, provisionerFactory)).toBe(sentinel);

    // 默认装配（createMailSenderFromConfig）：字段不全 → null，不抛错。
    expect(await configuredMailSender(db.d1)).toBeNull();
  });

  it('enabled:true 且字段齐全 → 双轴装配可用（默认 sender 装配出 send 口）', async () => {
    const db = createCoreDb();
    db.run("INSERT INTO instance_config (key, value) VALUES ('mail_stalwart', ?)", JSON.stringify(STALWART_SECTION));
    db.run("INSERT INTO instance_config (key, value) VALUES ('mail_smtp', ?)", JSON.stringify(SMTP_SECTION));

    const provisioner = await configuredMailProvisioner(db.d1, (config) => ({ marker: config }) as never);
    expect(provisioner).not.toBeNull();
    const sender = await configuredMailSender(db.d1);
    expect(sender?.send).toBeTypeOf('function');
  });
});

describe('旧 mail 键零读取（D2 回滚兼容：行保留，但读侧全走新键）', () => {
  it('库里只有旧 mail 行（缺省开语义的老数据）→ isMailEnabled=false、双轴不装配', async () => {
    const db = createCoreDb();
    // 旧形状：完整字段、无 enabled（旧代码视为开）；新代码必须不认这行。
    db.run(
      "INSERT INTO instance_config (key, value) VALUES ('mail', ?)",
      JSON.stringify({ baseUrl: 'https://mail.example.com', apiKey: 'k', domain: 'example.com', host: 'smtp.example.com', port: 465, username: 'u', password: 'p', from: 'no-reply@example.com' }),
    );
    const provisionerFactory = vi.fn(() => {
      throw new Error('provisioner must stay unconstructed');
    });

    expect(await isMailEnabled(db.d1)).toBe(false);
    expect(await configuredMailProvisioner(db.d1, provisionerFactory)).toBeNull();
    expect(await configuredMailSender(db.d1)).toBeNull();
    expect(provisionerFactory).not.toHaveBeenCalled();
    // D2：旧行未被读侧动过（保留回滚兼容）。
    expect(db.first<{ value: string }>("SELECT value FROM instance_config WHERE key = 'mail'")).not.toBeNull();
  });
});

describe('readMailAccess / /api/me 只看 mail_stalwart 段', () => {
  it('mail_smtp 段开着也喂不开开户轴：/api/me mailEnabled=false', async () => {
    const db = createCoreDb();
    db.run("INSERT INTO instance_config (key, value) VALUES ('mail_smtp', ?)", JSON.stringify(SMTP_SECTION));

    expect(await readMailAccess(db.d1)).toEqual({ enabled: false, portalUrl: null });
  });

  it('stalwart 段 enabled:false → /api/me mailEnabled=false 且不给门户地址（不误导）', async () => {
    const db = createCoreDb();
    db.run(
      "INSERT INTO instance_config (key, value) VALUES ('mail_stalwart', ?)",
      JSON.stringify({ ...STALWART_SECTION, enabled: false, portalUrl: 'https://portal.example.com' }),
    );

    expect(await readMailAccess(db.d1)).toEqual({ enabled: false, portalUrl: null });
  });

  it('stalwart 段 enabled:true → /api/me mailEnabled=true，portalUrl 优先于 domain 推导', async () => {
    const db = createCoreDb();
    db.run(
      "INSERT INTO instance_config (key, value) VALUES ('mail_stalwart', ?)",
      JSON.stringify({ ...STALWART_SECTION, portalUrl: 'https://portal.example.com/app-passwords' }),
    );

    expect(await readMailAccess(db.d1)).toEqual({ enabled: true, portalUrl: 'https://portal.example.com/app-passwords' });

    // 无 portalUrl 覆盖 → domain 推导 https://mail.<domain>（#168 语义不变）。
    const derived = createCoreDb();
    derived.run("INSERT INTO instance_config (key, value) VALUES ('mail_stalwart', ?)", JSON.stringify(STALWART_SECTION));
    expect(await readMailAccess(derived.d1)).toEqual({ enabled: true, portalUrl: 'https://mail.example.com' });
  });

  it('HTTP 行为：成员 /api/me 随 stalwart 段开关显隐（smtp 段不掺和）', async () => {
    const pair = await generateInstanceKeyPair();
    const db = createCoreDb();
    db.run(
      'INSERT INTO users (id, issuer, sub, display_name, email, role) VALUES (?, ?, ?, ?, ?, ?)',
      'u_member',
      'https://idp.example.com',
      'member-sub',
      '成员',
      'member@example.com',
      'user',
    );
    const memberCookie = `unself_session=${await createSessionToken(
      { uid: 'u_member', iss: 'https://idp.example.com', sub: 'member-sub', name: '成员' },
      pair.privateKeyPem,
    )}`;
    const env = { CORE_DB: db.d1, JWT_PRIVATE_KEY: pair.privateKeyPem };
    const app = createApp();

    // 只有 smtp 段 → 不算完整实例。
    db.run("INSERT INTO instance_config (key, value) VALUES ('mail_smtp', ?)", JSON.stringify(SMTP_SECTION));
    const off = await app.request('https://team.example.com/api/me', { headers: { cookie: memberCookie } }, env);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ mailEnabled: false, mailPortalUrl: null });

    // stalwart 开 → 完整实例，门户地址随段推导。
    db.run("INSERT INTO instance_config (key, value) VALUES ('mail_stalwart', ?)", JSON.stringify(STALWART_SECTION));
    const on = await app.request('https://team.example.com/api/me', { headers: { cookie: memberCookie } }, env);
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ mailEnabled: true, mailPortalUrl: 'https://mail.example.com' });
  });
});
