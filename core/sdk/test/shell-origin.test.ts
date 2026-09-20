// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createModuleSDK, resolveShellOrigin, SHELL_ORIGIN_META_NAME } from '../src/index';

const SHELL_ORIGIN = 'https://unself-core-api.sub.workers.dev';
const MODULE_ORIGIN = 'https://unself-module-hello.sub.workers.dev';

type MessageListener = (event: { origin: string; data: unknown }) => void;

interface FakeWindow {
  postMessage: ReturnType<typeof vi.fn>;
  dispatch: (event: { origin: string; data: unknown }) => void;
}

/** 当前生效的 fake window（供 fakeDispatch 辅助函数使用）。 */
let currentFake: FakeWindow | null = null;

/** 真 window stub 形状（同 sdk.test.ts 的 installFakeWindow）：可注册/摘除 message 监听。 */
function installFakeWindow(): FakeWindow {
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
  currentFake = {
    postMessage,
    dispatch: (event: { origin: string; data: unknown }) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
  return currentFake;
}

/** location stub：origin + 可选 ancestorOrigins（DOMStringList 形状，按索引取）。 */
function stubLocation(options: { origin: string; ancestorOrigins?: string[] }): void {
  vi.stubGlobal('location', {
    origin: options.origin,
    ...(options.ancestorOrigins === undefined
      ? {}
      : { ancestorOrigins: options.ancestorOrigins }),
  });
}

/** meta 注入 stub：querySelector 按 meta[name=…] 精确命中（行为级：查的是契约名）。 */
function stubMeta(content: string): void {
  vi.stubGlobal('document', {
    querySelector: (selectors: string) =>
      selectors === `meta[name="${SHELL_ORIGIN_META_NAME}"]` ? { getAttribute: () => content } : null,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveShellOrigin（#277 壳 origin 解析）', () => {
  it('跨子域 iframe：ancestorOrigins[0] 是壳 origin → 返回壳 origin', () => {
    stubLocation({ origin: MODULE_ORIGIN, ancestorOrigins: [SHELL_ORIGIN] });
    expect(resolveShellOrigin()).toBe(SHELL_ORIGIN);
  });

  it('Firefox 无 ancestorOrigins：meta content = 壳 origin → 返回壳 origin', () => {
    stubLocation({ origin: MODULE_ORIGIN });
    stubMeta(SHELL_ORIGIN);
    expect(resolveShellOrigin()).toBe(SHELL_ORIGIN);
  });

  it('两者都无（非 iframe 直开）→ 返回 location.origin', () => {
    stubLocation({ origin: MODULE_ORIGIN });
    expect(resolveShellOrigin()).toBe(MODULE_ORIGIN);
  });

  it("ancestorOrigins=['null']（opaque origin）：不采纳 → 落 meta；meta 也无 → 自身 origin", () => {
    stubLocation({ origin: MODULE_ORIGIN, ancestorOrigins: ['null'] });
    expect(resolveShellOrigin()).toBe(MODULE_ORIGIN); // meta 也无 → 回落自身 origin。

    stubMeta(SHELL_ORIGIN);
    expect(resolveShellOrigin()).toBe(SHELL_ORIGIN); // 有 meta → meta 胜过无效祖先。
  });

  it('优先级：ancestorOrigins 与 meta 都给且不同 → ancestorOrigins 胜', () => {
    stubLocation({ origin: MODULE_ORIGIN, ancestorOrigins: [SHELL_ORIGIN] });
    stubMeta('https://meta-not-consulted.example');
    expect(resolveShellOrigin()).toBe(SHELL_ORIGIN);
  });

  it('空白 / 全空白 origin 一律视为无效并降级', () => {
    // ancestorOrigins 空白 → 落 location.origin。
    stubLocation({ origin: MODULE_ORIGIN, ancestorOrigins: ['   '] });
    expect(resolveShellOrigin()).toBe(MODULE_ORIGIN);
    // meta 空白 → 也落 location.origin。
    stubLocation({ origin: MODULE_ORIGIN });
    stubMeta('  ');
    expect(resolveShellOrigin()).toBe(MODULE_ORIGIN);
  });

  it('取到的值会 trim', () => {
    stubLocation({ origin: `  ${MODULE_ORIGIN}  `, ancestorOrigins: [` ${SHELL_ORIGIN} `] });
    expect(resolveShellOrigin()).toBe(SHELL_ORIGIN);
  });
});

describe('行为端点：createModuleSDK + resolveShellOrigin（握手不退化回 location.origin）', () => {
  it('coreOrigin=resolveShellOrigin() 时，壳 origin 的 token 消息被接受、模块自身 origin 的被拒', async () => {
    // 跨子域 iframe 场景：模块自身 origin ≠ 壳 origin。若 helper 退化回
    // location.origin，waitForToken 只会接受自己发给自己的消息 → 本用例红。
    stubLocation({ origin: MODULE_ORIGIN, ancestorOrigins: [SHELL_ORIGIN] });
    const fake = installFakeWindow();
    const sdk = createModuleSDK({ moduleId: 'x', coreOrigin: resolveShellOrigin()! });
    expect(resolveShellOrigin()).not.toBe(MODULE_ORIGIN); // 前置守卫：确实处于跨子域形态。

    const promise = sdk.waitForToken();

    // 模块自身 origin 冒充的 token：不被接受。
    fake.dispatch({
      origin: MODULE_ORIGIN,
      data: { type: 'token', token: 'self-origin-token' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 壳 origin 下发的 token：resolve。
    fake.dispatch({
      origin: SHELL_ORIGIN,
      data: { type: 'token', token: 'shell-token' },
    });
    await expect(promise).resolves.toBe('shell-token');
  });
});
