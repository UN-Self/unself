// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createModuleSDK, decodeJwtPayload, verifyModuleToken } from '../src/index';

/**
 * 手造 JWT：header / payload / signature 均为 base64url。
 * payload 字段与 @unself/contracts ModuleTokenClaimsSchema 对齐。
 */
const B64URL_HEADER = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0';
const B64URL_PAYLOAD_PLAIN =
  'eyJpc3MiOiJodHRwczovL2NvcmUudW5zZWxmLmV4YW1wbGUiLCJzdWIiOiJtb2QtYSIsImF1ZCI6ImNvcmUtYXBpIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE4MDAwMDAwMDB9';
const B64URL_PAYLOAD_WITH_ACT =
  'eyJpc3MiOiJodHRwczovL2NvcmUudW5zZWxmLmV4YW1wbGUiLCJzdWIiOiJtb2QtYSIsImF1ZCI6ImNvcmUtYXBpIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE4MDAwMDAwMDAsImFjdCI6eyJzdWIiOiJtb2QtYiJ9LCJjYXBzIjpbIm5vdGlmeSJdfQ';
const B64URL_SIGNATURE = 'c2lnbmF0dXJl';
const B64URL_PAYLOAD_UTF8 = 'eyJ0aXRsZSI6IuS9oOWlvSIsImNvdW50IjoxfQ';

const claims = {
  iss: 'https://core.unself.example',
  sub: 'mod-a',
  aud: 'core-api',
  iat: 1_700_000_000,
  exp: 1_800_000_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodeJwtPayload', () => {
  it('decodes the payload of a hand-crafted JWT', () => {
    const token = `${B64URL_HEADER}.${B64URL_PAYLOAD_PLAIN}.${B64URL_SIGNATURE}`;
    expect(decodeJwtPayload(token)).toEqual(claims);
  });

  it('decodes UTF-8 payloads', () => {
    const token = `${B64URL_HEADER}.${B64URL_PAYLOAD_UTF8}.${B64URL_SIGNATURE}`;
    expect(decodeJwtPayload(token)).toEqual({ title: '你好', count: 1 });
  });

  it('decodeContext returns schema-typed claims (no signature check)', () => {
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: 'https://core.unself.example' });
    const token = `${B64URL_HEADER}.${B64URL_PAYLOAD_WITH_ACT}.${B64URL_SIGNATURE}`;
    expect(sdk.decodeContext(token).act?.sub).toBe('mod-b');
    expect(sdk.decodeContext(token).caps).toEqual(['notify']);
  });
});

type MessageListener = (event: { origin: string; data: unknown }) => void;

function installFakeWindow(): { dispatch: (event: { origin: string; data: unknown }) => void } {
  const listeners = new Set<MessageListener>();
  vi.stubGlobal('window', {
    parent: { postMessage: vi.fn() },
    addEventListener: (_type: string, listener: MessageListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: MessageListener) => {
      listeners.delete(listener);
    },
  });
  return {
    dispatch: (event: { origin: string; data: unknown }) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

describe('waitForToken', () => {
  it('does not resolve on a message from an untrusted origin', async () => {
    const fake = installFakeWindow();
    const sdk = createModuleSDK({
      moduleId: 'mod-a',
      coreOrigin: 'https://core.unself.example',
    });

    let resolved: string | null = null;
    const promise = sdk.waitForToken().then((token) => {
      resolved = token;
      return token;
    });

    // 非法 origin：不得 resolve。
    fake.dispatch({ origin: 'https://evil.example', data: { type: 'token', token: 'evil-token' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBeNull();

    // 合法 origin：正常 resolve。
    fake.dispatch({ origin: 'https://core.unself.example', data: { type: 'token', token: 'good-token' } });
    await expect(promise).resolves.toBe('good-token');
  });

  it('rejects when window is unavailable', async () => {
    const sdk = createModuleSDK({ moduleId: 'mod-a' });
    await expect(sdk.waitForToken()).rejects.toThrow();
  });
});

describe('verifyModuleToken', () => {
  it('rejects a garbage token (fails inside jose before any JWKS fetch)', async () => {
    await expect(
      verifyModuleToken('not-a-jwt', {
        jwksUrl: 'https://core.unself.example/.well-known/jwks.json',
        audience: 'core-api',
      }),
    ).rejects.toThrow();
  });
});
