// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

import { readBearer, requireAuth } from '../src/auth/bearer';

import { claims } from './claims';

/**
 * 认证三态（#358 §7 T3 验收）：401 / 401 / 503 各管一件事，混了就查不出问题到底是
 * 「用户令牌坏了」还是「部署没给公钥」。
 */
describe('readBearer', () => {
  it('取不出令牌的形态一律 null', () => {
    expect(readBearer(undefined)).toBeNull();
    expect(readBearer('')).toBeNull();
    expect(readBearer('Basic dXNlcjpwYXNz')).toBeNull();
    expect(readBearer('Bearer')).toBeNull();
    expect(readBearer('Bearer    ')).toBeNull();
  });

  it('scheme 大小写不敏感（RFC 7235），令牌原样返回', () => {
    expect(readBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(readBearer('bearer abc.def.ghi')).toBe('abc.def.ghi');
  });
});

describe('requireAuth', () => {
  it('缺令牌 → 401 missing_bearer_token（即使本进程也没有公钥）', async () => {
    const outcome = await requireAuth({ authorization: undefined, verifier: null });
    expect(outcome).toEqual({ ok: false, status: 401, body: { error: 'missing_bearer_token' } });
  });

  it('有令牌但拿不到公钥 → 503 jwks_unavailable（不是 401）', async () => {
    const outcome = await requireAuth({ authorization: 'Bearer abc', verifier: null });
    expect(outcome).toEqual({ ok: false, status: 503, body: { error: 'jwks_unavailable' } });
  });

  it('验签抛错（签名不符/过期/aud 不符）→ 401 token_invalid，不区分原因', async () => {
    const verifier = vi.fn(async () => {
      throw new Error('signature verification failed');
    });
    const outcome = await requireAuth({ authorization: 'Bearer abc', verifier });
    expect(outcome).toEqual({ ok: false, status: 401, body: { error: 'token_invalid' } });
  });

  it('验签通过 → 原样交出 claims，令牌按原文交给验签器（不 trim、不重拼）', async () => {
    const verifier = vi.fn(async () => claims({ sub: 'user-42' }));
    const outcome = await requireAuth({ authorization: 'Bearer x.y.z', verifier });
    expect(verifier).toHaveBeenCalledWith('x.y.z');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.claims.sub).toBe('user-42');
  });
});
