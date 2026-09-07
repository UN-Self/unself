// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
  createSessionToken,
  verifySessionToken,
  sessionCookieOptions,
  b64urlDecode,
} from '../src/session';

const SECRET_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIBiU4am3dpuNlbVsF2H5Y7QaYvJxy40CGAs1Tf1vH0T6
-----END PRIVATE KEY-----`;

describe('会话 token（HMAC 签名 Cookie）', () => {
  it('签发后可校验并还原 payload', async () => {
    const token = await createSessionToken(
      { uid: 'u_1', iss: 'https://idp', sub: 'u-123', name: '黄一' },
      SECRET_PEM,
    );
    const payload = await verifySessionToken(token, SECRET_PEM);
    expect(payload).not.toBeNull();
    expect(payload?.uid).toBe('u_1');
    expect(payload?.name).toBe('黄一');
    // exp = now + TTL
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('篡改 payload / 签名 / 换密钥均拒绝', async () => {
    const token = await createSessionToken(
      { uid: 'u_1', iss: 'https://idp', sub: 'u-123', name: 'n' },
      SECRET_PEM,
    );
    const [body, sig] = token.split('.') as [string, string];
    // 改 payload
    const evil = JSON.parse(new TextDecoder().decode(b64urlDecode(body)!));
    evil.uid = 'u_admin';
    const evilBody = Buffer.from(JSON.stringify(evil), 'utf8').toString('base64url');
    expect(await verifySessionToken(`${evilBody}.${sig}`, SECRET_PEM)).toBeNull();
    // 改签名
    expect(await verifySessionToken(`${body}.AAAA${sig?.slice(4) ?? ''}`, SECRET_PEM)).toBeNull();
    // 换密钥
    expect(await verifySessionToken(token, '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----')).toBeNull();
  });

  it('过期会话拒绝', async () => {
    const token = await createSessionToken(
      { uid: 'u_1', iss: 'https://idp', sub: 'u-123', name: 'n' },
      SECRET_PEM,
    );
    // 用过期后的视角校验：直接改 payload 会破坏签名，改为 mock 时间
    const realNow = Date.now;
    Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000; // 8 天后
    try {
      expect(await verifySessionToken(token, SECRET_PEM)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('垃圾输入拒绝', async () => {
    expect(await verifySessionToken('garbage', SECRET_PEM)).toBeNull();
    expect(await verifySessionToken('a.b', SECRET_PEM)).toBeNull();
    expect(await verifySessionToken('', SECRET_PEM)).toBeNull();
    // body 是合法 b64url 但非 JSON
    expect(await verifySessionToken('e30.C3fA1aKE', SECRET_PEM)).toBeNull();
  });

  it('Cookie 参数：HttpOnly + SameSite=Lax + Secure', () => {
    const opts = sessionCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('Lax');
    expect(opts.secure).toBe(true);
    expect(opts.maxAge).toBeGreaterThan(0);
  });
});
