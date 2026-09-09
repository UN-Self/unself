// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type CryptoKey } from 'jose';

import { DEFAULT_THEME, SdkMessageSchema, THEME_TOKEN_KEYS } from '@unself/contracts';

import {
  createModuleSDK,
  decodeJwtPayload,
  verifyModuleToken,
  type ThemeTokens,
} from '../src/index';

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

/** 最小 document stub（通道 B 只在写 :root 时用到 setProperty）。 */
function installFakeDocument(): { setProperty: ReturnType<typeof vi.fn> } {
  const setProperty = vi.fn();
  vi.stubGlobal('document', {
    documentElement: { style: { setProperty } },
  });
  return { setProperty };
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

  it('outbound guards are runtime-conditional: no window → parent untouched; window → real postMessage', () => {
    // 无 window 环境：globalThis.parent 换成带 spy 的 getter。
    // 若守卫失效，出站调用要么直接命中 spy，要么对 undefined 解包抛错——两者都判失败。
    const parentGetter = vi.fn(() => undefined);
    Object.defineProperty(globalThis, 'parent', { configurable: true, get: parentGetter });
    try {
      const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
      expect(() => {
        sdk.ready();
        sdk.navigate('/m/a');
        sdk.notify('x');
        sdk.theme('dark');
      }).not.toThrow();
      expect(parentGetter).not.toHaveBeenCalled();

      // 同一 SDK：装上浏览器式 window 后必须真的走 postMessage 通道（守卫是运行时条件，不是 no-op 桩）。
      const fake = installFakeWindow();
      sdk.ready();
      expect(fake.postMessage).toHaveBeenCalledWith({ type: 'ready' }, CORE_ORIGIN);
      sdk.navigate('/m/a');
      expect(fake.postMessage).toHaveBeenCalledWith(
        { type: 'navigate', path: '/m/a' },
        CORE_ORIGIN,
      );
    } finally {
      Reflect.deleteProperty(globalThis, 'parent');
    }
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
  let privateKey: CryptoKey;
  let coreJwksJson: string;

  beforeEach(async () => {
    // 真实 ES256 密钥对；kid = RFC 7638 JWK 指纹（与 Core 签发侧同规）。
    const pair = await generateKeyPair('ES256', { extractable: true });
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    const kid = await calculateJwkThumbprint(publicJwk);
    coreJwksJson = JSON.stringify({ keys: [{ ...publicJwk, kid, use: 'sig', alg: 'ES256' }] });
  });

  async function sign(overrides: Record<string, unknown> = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const kid = (JSON.parse(coreJwksJson) as { keys: { kid: string }[] }).keys[0]!.kid;
    return new SignJWT({ iss: 'https://core.unself.example', sub: 'mod-a', aud: 'core-api', ...overrides })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(privateKey);
  }

  it('verifies a token signed by the core key pair and returns schema-parsed claims', async () => {
    // 签名 keypair 与注入 JWKS 同源：jose 本地验签通过，claims 载荷原样解析。
    const now = Math.floor(Date.now() / 1000);
    const token = await sign();
    await expect(verifyModuleToken(token, { coreJwksJson, audience: 'core-api' })).resolves.toEqual({
      iss: 'https://core.unself.example',
      sub: 'mod-a',
      aud: 'core-api',
      iat: now,
      exp: now + 600,
    });
  });

  it('rejects a garbage token (fails inside jose before any key use)', async () => {
    await expect(
      verifyModuleToken('not-a-jwt', { coreJwksJson, audience: 'core-api' }),
    ).rejects.toThrow();
  });

  it('rejects a token signed by a different key pair (signature mismatch)', async () => {
    const other = await generateKeyPair('ES256', { extractable: true });
    const token = await new SignJWT({
      iss: 'https://core.unself.example',
      sub: 'mod-a',
      aud: 'core-api',
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(other.privateKey);
    await expect(verifyModuleToken(token, { coreJwksJson, audience: 'core-api' })).rejects.toThrow();
  });

  it('rejects a token with the wrong audience (aud 锁定不变)', async () => {
    const token = await sign({ aud: 'other-module' });
    await expect(verifyModuleToken(token, { coreJwksJson, audience: 'core-api' })).rejects.toThrow(
      /aud/,
    );
  });

  it('verifies with zero network calls: global fetch throwing does not break verification', async () => {
    // 本地 JWKS 验签：即使网络被破坏（fetch 抛错），合法 token 仍通过——B 方案零运行时网络的直接证明。
    vi.stubGlobal('fetch', () => {
      throw new Error('network must not be used');
    });
    const token = await sign();
    await expect(verifyModuleToken(token, { coreJwksJson, audience: 'core-api' })).resolves.toEqual(
      expect.objectContaining({ sub: 'mod-a', aud: 'core-api' }),
    );
  });
});

describe('主题通道 B（tokens 消息 / getTokens / applyTheme，§6.5.5-6.5.7）', () => {
  const MESSAGE = {
    type: 'tokens',
    tokens: { 'unself.color.primary': '#0f62fe' },
  } as const;

  it('getTokens resolves the default theme before any tokens message（全契约键兜底）', async () => {
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    const tokens = await sdk.getTokens();
    // 不必逐键：抽 2-3 个代表键 + 键数全量对齐契约白名单。
    expect(tokens['unself.color.primary']).toBe(DEFAULT_THEME['unself.color.primary']);
    expect(tokens['unself.space.4']).toBe(DEFAULT_THEME['unself.space.4']);
    expect(tokens['unself.shadow.card']).toBe(DEFAULT_THEME['unself.shadow.card']);
    expect(Object.keys(tokens)).toHaveLength(THEME_TOKEN_KEYS.length);
  });

  it('merges a trusted partial tokens message over the default theme', async () => {
    const fake = installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    await sdk.getTokens(); // 首次调用：惰性注册 tokens 监听器。

    fake.dispatch({ origin: CORE_ORIGIN, data: MESSAGE });
    const tokens = await sdk.getTokens();
    expect(tokens['unself.color.primary']).toBe('#0f62fe');
    // 未覆盖的键走平台默认（§6.5.4 部分覆盖合法）。
    expect(tokens['unself.space.4']).toBe(DEFAULT_THEME['unself.space.4']);
    expect(Object.keys(tokens)).toHaveLength(THEME_TOKEN_KEYS.length);
  });

  it('writes received tokens into :root automatically（标准件自动跟随，零配置）', async () => {
    const fake = installFakeWindow();
    const { setProperty } = installFakeDocument();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    await sdk.getTokens(); // 注册监听，但未收到消息前不写 :root。
    expect(setProperty).not.toHaveBeenCalled();

    fake.dispatch({ origin: CORE_ORIGIN, data: MESSAGE });
    expect(setProperty).toHaveBeenCalledWith('--unself-color-primary', '#0f62fe');
    // 生效集是全量（默认兜底逐键写入），模块页 var() 全部可解析（§6.5.8 体检口径）。
    expect(setProperty).toHaveBeenCalledWith('--unself-space-4', DEFAULT_THEME['unself.space.4']);
  });

  it('ignores tokens messages from untrusted origins', async () => {
    const fake = installFakeWindow();
    const { setProperty } = installFakeDocument();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    await sdk.getTokens();

    fake.dispatch({
      origin: 'https://evil.example',
      data: { type: 'tokens', tokens: { 'unself.color.primary': '#ff0000' } },
    });
    const tokens = await sdk.getTokens();
    expect(tokens['unself.color.primary']).toBe(DEFAULT_THEME['unself.color.primary']);
    expect(setProperty).not.toHaveBeenCalledWith('--unself-color-primary', '#ff0000');
  });

  it('ignores invalid tokens payloads（未知名 / 非字符串 / 空串：不写入、不覆盖）', async () => {
    const fake = installFakeWindow();
    const { setProperty } = installFakeDocument();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    await sdk.getTokens();

    fake.dispatch({
      origin: CORE_ORIGIN,
      data: { type: 'tokens', tokens: { 'unself.color.nope': '#000000' } },
    });
    fake.dispatch({
      origin: CORE_ORIGIN,
      data: { type: 'tokens', tokens: { 'unself.color.primary': 42 } },
    });
    fake.dispatch({
      origin: CORE_ORIGIN,
      data: { type: 'tokens', tokens: { 'unself.color.primary': '' } },
    });

    const tokens = await sdk.getTokens();
    expect(tokens['unself.color.primary']).toBe(DEFAULT_THEME['unself.color.primary']);
    expect(setProperty).not.toHaveBeenCalledWith('--unself-color-primary', '#0f62fe');
    expect(setProperty).not.toHaveBeenCalledWith('--unself-color-primary', '#000000');
  });

  it('applyTheme writes :root and wins over shell-delivered values（模块内覆盖 > 壳下发，§6.5.6）', async () => {
    const fake = installFakeWindow();
    const { setProperty } = installFakeDocument();
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    await sdk.getTokens(); // 确保监听就位，再收壳下发的实例主题。

    fake.dispatch({
      origin: CORE_ORIGIN,
      data: { type: 'tokens', tokens: { 'unself.space.4': '24px', 'unself.color.primary': '#0f62fe' } },
    });

    sdk.applyTheme({ 'unself.space.4': '20px' });
    expect(setProperty).toHaveBeenCalledWith('--unself-space-4', '20px');

    const tokens = await sdk.getTokens();
    expect(tokens['unself.space.4']).toBe('20px'); // 模块内覆盖胜出。
    expect(tokens['unself.color.primary']).toBe('#0f62fe'); // 未覆盖的键仍随壳下发。
  });

  it('applyTheme throws on unknown keys and non-string/empty values', () => {
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });
    expect(() => sdk.applyTheme({ 'unself.color.nope': '#000000' })).toThrow(/unknown theme token/);
    expect(() =>
      sdk.applyTheme({ 'unself.color.primary': 42 } as unknown as ThemeTokens),
    ).toThrow(/module-sdk: invalid theme tokens/);
    expect(() => sdk.applyTheme({ 'unself.color.primary': '' })).toThrow(
      /module-sdk: invalid theme tokens/,
    );
  });

  it('does not throw without document（runtime 守卫生效：只跳过 :root 写入）', async () => {
    const fake = installFakeWindow(); // window 在、document 不在：Node 侧 / 测试场景。
    const sdk = createModuleSDK({ moduleId: 'mod-a', coreOrigin: CORE_ORIGIN });

    expect(() => sdk.applyTheme({ 'unself.space.4': '20px' })).not.toThrow();
    expect(() =>
      fake.dispatch({ origin: CORE_ORIGIN, data: MESSAGE }),
    ).not.toThrow();

    // 状态合并不受影响，只是不写 :root。
    const tokens = await sdk.getTokens();
    expect(tokens['unself.space.4']).toBe('20px');
    expect(tokens['unself.color.primary']).toBe('#0f62fe');
  });

  it('tokens message contract shape（SdkMessageSchema：tokens 必填、tokens 须为映射）', () => {
    expect(
      SdkMessageSchema.safeParse({ type: 'tokens', tokens: { 'unself.color.primary': '#0f62fe' } })
        .success,
    ).toBe(true);
    expect(SdkMessageSchema.safeParse({ type: 'tokens' }).success).toBe(false);
    expect(SdkMessageSchema.safeParse({ type: 'tokens', tokens: 'not-a-map' }).success).toBe(false);
  });
});
