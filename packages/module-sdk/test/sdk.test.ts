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

const CORE_ORIGIN = 'https://core.unself.example';

/** 按 claims 动态造 token（iat/exp 可覆盖），续期测试用。 */
function makeToken(overrides: Partial<{ iat: number; exp: number }> = {}): string {
  const payload = { ...claims, ...overrides };
  return `${B64URL_HEADER}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${B64URL_SIGNATURE}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    const token = `${B64URL_HEADER}.${B64URL_PAYLOAD_WITH_ACT}.${B64URL_SIGNATURE}`;
    expect(sdk.decodeContext(token).act?.sub).toBe('mod-b');
    expect(sdk.decodeContext(token).caps).toEqual(['notify']);
  });
});

type MessageListener = (event: { origin: string; data: unknown }) => void;

function installFakeWindow(): {
  postMessage: ReturnType<typeof vi.fn>;
  dispatch: (event: { origin: string; data: unknown }) => void;
} {
  const postMessage = vi.fn();
  const listeners = new Set<MessageListener>();
  vi.stubGlobal('window', {
    parent: { postMessage },
    addEventListener: (_type: string, listener: MessageListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: MessageListener) => {
      listeners.delete(listener);
    },
  });
  return {
    postMessage,
    dispatch: (event: { origin: string; data: unknown }) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

describe('outbound messages（ready / navigate / notify / theme）', () => {
  it('ready posts {type:"ready"} to the configured coreOrigin', () => {
    const fake = installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    sdk.ready();
    expect(fake.postMessage).toHaveBeenCalledWith({ type: 'ready' }, CORE_ORIGIN);
  });

  it('navigate / notify / theme post matching contract messages', () => {
    const fake = installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });

    sdk.navigate('/m/chat/rooms/42');
    expect(fake.postMessage).toHaveBeenCalledWith(
      { type: 'navigate', path: '/m/chat/rooms/42' },
      CORE_ORIGIN,
    );

    sdk.notify('会议开始了');
    expect(fake.postMessage).toHaveBeenCalledWith(
      { type: 'notify', title: '会议开始了' },
      CORE_ORIGIN,
    );

    sdk.notify('会议开始了', '会议室 A');
    expect(fake.postMessage).toHaveBeenCalledWith(
      { type: 'notify', title: '会议开始了', body: '会议室 A' },
      CORE_ORIGIN,
    );

    sdk.theme('dark');
    expect(fake.postMessage).toHaveBeenCalledWith(
      { type: 'theme', mode: 'dark' },
      CORE_ORIGIN,
    );

    sdk.theme('light');
    expect(fake.postMessage).toHaveBeenCalledWith(
      { type: 'theme', mode: 'light' },
      CORE_ORIGIN,
    );
  });

  it('theme rejects modes outside the contract enum at runtime', () => {
    installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    // @ts-expect-error 故意传契约之外的 mode（SdkMessageSchema z.enum(['light','dark'])）
    expect(() => sdk.theme('sepia')).toThrow(/invalid theme mode/);
  });

  it('outbound messages are no-ops without a window', () => {
    const sdk = createModuleSDK({ moduleId: 'mod-a' });
    expect(() => {
      sdk.ready();
      sdk.navigate('/m/a');
      sdk.notify('x');
      sdk.theme('dark');
    }).not.toThrow();
  });
});

describe('waitForToken', () => {
  it('does not resolve on a message from an untrusted origin', async () => {
    const fake = installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });

    let resolved: string | null = null;
    const promise = sdk.waitForToken().then((token) => {
      resolved = token;
      return token;
    });

    // 非法 origin：不得 resolve。
    fake.dispatch({ origin: 'https://evil.example', data: { type: 'token', token: 'evil-token' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBeNull();

    // 合法 origin：正常 resolve 且 listener 已摘除。
    fake.dispatch({ origin: CORE_ORIGIN, data: { type: 'token', token: 'good-token' } });
    await expect(promise).resolves.toBe('good-token');
  });

  it('ignores non-token messages from the trusted origin', async () => {
    const fake = installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });

    let resolved: string | null = null;
    const promise = sdk.waitForToken().then((token) => {
      resolved = token;
      return token;
    });

    // 同源但形状不对（ready / malformed token）：不得 resolve。
    fake.dispatch({ origin: CORE_ORIGIN, data: { type: 'ready' } });
    fake.dispatch({ origin: CORE_ORIGIN, data: { type: 'token' } });
    fake.dispatch({ origin: CORE_ORIGIN, data: { type: 'token', token: 123 } });
    fake.dispatch({ origin: CORE_ORIGIN, data: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBeNull();

    fake.dispatch({ origin: CORE_ORIGIN, data: { type: 'token', token: 'good-token' } });
    await expect(promise).resolves.toBe('good-token');
  });

  it('rejects when coreOrigin is not configured (secure default: no wildcard)', async () => {
    // 故意保留 window：拒绝必须源于「未配置 coreOrigin」，而不是 window 缺失。
    installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a' });
    await expect(sdk.waitForToken()).rejects.toThrow(/coreOrigin is not configured/);
  });

  it('rejects when window is unavailable', async () => {
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    await expect(sdk.waitForToken()).rejects.toThrow(/window is not available/);
  });
});

describe('startTokenLoop / stopTokenLoop（静默续期）', () => {
  it('renews via a ready handshake ~2min before a 10min token expires', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    const now = Math.floor(Date.now() / 1000);

    // TTL = 10 分钟，提前量 = min(2min, TTL/3) = 2min → 480s 后触发续期。
    sdk.startTokenLoop(makeToken({ iat: now, exp: now + 600 }));
    expect(fake.postMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(480_000 - 1);
    expect(fake.postMessage).not.toHaveBeenCalledWith({ type: 'ready' }, CORE_ORIGIN);

    vi.advanceTimersByTime(1);
    expect(fake.postMessage).toHaveBeenCalledWith({ type: 'ready' }, CORE_ORIGIN);
  });

  it('clamps the lead to TTL/3 for short-lived tokens (at least 1/3 TTL usable)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    const now = Math.floor(Date.now() / 1000);

    // TTL = 3 分钟：提前量 = min(2min, 1min) = 1min → 到期前 2 分钟（= 2/3 TTL 已用）触发。
    sdk.startTokenLoop(makeToken({ iat: now, exp: now + 180 }));
    vi.advanceTimersByTime(120_000 - 1);
    expect(fake.postMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fake.postMessage).toHaveBeenCalledWith({ type: 'ready' }, CORE_ORIGIN);
  });

  it('re-arms with the renewed token from the shell and keeps renewing', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    const onToken = vi.fn();
    const now = Math.floor(Date.now() / 1000);

    sdk.startTokenLoop(makeToken({ iat: now, exp: now + 600 }), onToken);

    // 第一次续期：重发 ready → 壳回发新 token。
    vi.advanceTimersByTime(480_000);
    expect(fake.postMessage).toHaveBeenCalledTimes(1);
    expect(fake.postMessage).toHaveBeenCalledWith({ type: 'ready' }, CORE_ORIGIN);

    const renewedAt = Math.floor(Date.now() / 1000);
    fake.dispatch({
      origin: CORE_ORIGIN,
      data: { type: 'token', token: makeToken({ iat: renewedAt, exp: renewedAt + 600 }) },
    });
    expect(onToken).toHaveBeenCalledTimes(1);

    // 第二个 10 分钟周期：仍按 exp-2min 续期。
    vi.advanceTimersByTime(480_000);
    expect(fake.postMessage).toHaveBeenCalledTimes(2);
  });

  it('ignores renewal messages from untrusted origins', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    const now = Math.floor(Date.now() / 1000);

    sdk.startTokenLoop(makeToken({ iat: now, exp: now + 600 }));
    // 恶意 origin 的 token：不得重排续期定时器。
    fake.dispatch({
      origin: 'https://evil.example',
      data: { type: 'token', token: makeToken({ iat: now, exp: now + 600 }) },
    });
    vi.advanceTimersByTime(480_000 + 480_000 + 1_000);
    // 只有原定时器触发的一次续期，恶意 token 未生效。
    expect(fake.postMessage).toHaveBeenCalledTimes(1);
  });

  it('renews immediately when the initial token is already expired', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    const now = Math.floor(Date.now() / 1000);

    sdk.startTokenLoop(makeToken({ iat: now - 1200, exp: now - 600 }));
    expect(fake.postMessage).toHaveBeenCalledWith({ type: 'ready' }, CORE_ORIGIN);
  });

  it('stopTokenLoop cancels the pending renewal and detaches the listener', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fake = installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    const now = Math.floor(Date.now() / 1000);

    sdk.startTokenLoop(makeToken({ iat: now, exp: now + 600 }));
    sdk.stopTokenLoop();
    vi.advanceTimersByTime(600_000);
    expect(fake.postMessage).not.toHaveBeenCalled();

    // 摘除外：之后到达的 token 不再触发任何续期调度。
    fake.dispatch({
      origin: CORE_ORIGIN,
      data: { type: 'token', token: makeToken({ iat: now, exp: now + 600 }) },
    });
    vi.advanceTimersByTime(480_000 + 1_000);
    expect(fake.postMessage).not.toHaveBeenCalled();
  });

  it('refuses to start without coreOrigin configured', () => {
    installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a' });
    expect(() => sdk.startTokenLoop(makeToken())).toThrow(/coreOrigin is not configured/);
  });

  it('throws on a malformed initial token', () => {
    installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    expect(() => sdk.startTokenLoop('not-a-jwt')).toThrow();
  });

  it('throws on tokens whose exp is not after iat', () => {
    installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    expect(() => sdk.startTokenLoop(makeToken({ iat: 200, exp: 100 }))).toThrow(
      /exp must be after iat/,
    );
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
