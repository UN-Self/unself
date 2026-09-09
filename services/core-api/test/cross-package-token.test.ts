// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { ModuleTokenClaimsSchema } from '@unself/contracts';
import { verifyModuleToken } from '@unself/module-sdk';

import app from '../src/index';
import { generateInstanceKeyPair } from '../src/keys';
import { createCoreDb } from './test-factory';

/**
 * 跨包契约链（#81 验收项 2）：
 *   core-api 签发（POST /api/modules/hello/token）
 *   → @unself/contracts ModuleTokenClaimsSchema.parse（claims 过 schema）
 *   → @unself/module-sdk verifyModuleToken（JWKS 验签 + aud + schema）
 * 一条测试走完全链，任一边契约漂移（aud/sub 语义、name 字段、JWKS 不匹配）即红。
 */
const helloManifest = {
  id: 'hello',
  route: '/m/hello',
  entry: 'https://team.example.com/m/hello/',
  runtime: 'worker',
  requires: ['identity'],
  capabilities: ['counter'],
  version: '1.0.0',
};

describe('跨包契约链：core-api 签发 → contracts schema → module-sdk 验签', () => {
  it('签发 token 全链可验：claims 语义（aud=模块 id、sub=用户 uid、name=展示名）与 SDK 一致', async () => {
    const pair = await generateInstanceKeyPair();
    const db = createCoreDb();
    db.run(
      'INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES (?, ?, ?, ?)',
      'hello',
      1,
      helloManifest.version,
      JSON.stringify(helloManifest),
    );
    db.run(
      'INSERT INTO users (id, issuer, sub, display_name, role) VALUES (?, ?, ?, ?, ?)',
      'u_1',
      'https://idp',
      'u-1',
      '黄一',
      'user',
    );
    const { createSessionToken } = await import('../src/session');
    const sessionToken = await createSessionToken(
      { uid: 'u_1', iss: 'https://idp', sub: 'u-1', name: '黄一' },
      pair.privateKeyPem,
    );
    const env = {
      JWT_PRIVATE_KEY: pair.privateKeyPem,
      CORE_DB: db.d1,
    };

    // ① core-api 签发（真库模块行 + 真会话）
    const issued = await app.request(
      'https://team.example.com/api/modules/hello/token',
      { method: 'POST', headers: { cookie: `unself_session=${sessionToken}` } },
      env,
    );
    expect(issued.status).toBe(200);
    const { token, claims } = (await issued.json()) as {
      token: string;
      claims: Record<string, unknown>;
    };

    // ② contracts：claims 过 ModuleTokenClaimsSchema（语义与签出响应一致）
    const parsed = ModuleTokenClaimsSchema.parse(claims);
    expect(parsed.aud).toBe('hello'); // aud = 模块 id
    expect(parsed.sub).toBe('u_1'); // sub = 核心用户 uid
    expect(parsed.name).toBe('黄一'); // 身份行展示名（会话同步）

    // ③ module-sdk：本地 JWKS（core-api /.well-known/jwks.json 响应体）验签 + aud 校验
    const jwksRes = await app.request('https://team.example.com/.well-known/jwks.json', {}, env);
    expect(jwksRes.status).toBe(200);
    const verified = await verifyModuleToken(token, {
      coreJwksJson: await jwksRes.text(),
      audience: 'hello',
    });
    expect(verified.sub).toBe('u_1');
    expect(verified.aud).toBe('hello');
    expect(verified.name).toBe('黄一');
  });
});
