// SPDX-License-Identifier: AGPL-3.0-only
import { ModuleTokenClaimsSchema, type ModuleTokenClaims } from '@unself/contracts';

/**
 * window 最小访问面（不引入 DOM lib：包可运行在 Node 侧，测试用 stub window）。
 */
interface ParentPort {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface WindowLike {
  parent: ParentPort;
  addEventListener(type: 'message', listener: (event: MessageLikeEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageLikeEvent) => void): void;
}

interface MessageLikeEvent {
  origin: string;
  data: unknown;
}

declare const window: WindowLike;
declare const atob: (data: string) => string;
declare const TextDecoder: new () => { decode(input: Uint8Array): string };

export interface CreateModuleSDKOptions {
  /** 当前模块 id（M1 握手上下文保留字段）。 */
  moduleId: string;
  /** Core（embedding shell）页面 origin；缺省用 '*'（iframe 环境等宽放场景）。 */
  coreOrigin?: string;
}

export interface ModuleSDK {
  /** 向 Core 发送就绪消息。 */
  ready(): void;
  /** 监听 Core 下发的 token 消息（校验 event.origin）。 */
  waitForToken(): Promise<string>;
  /** 请求 Core 导航到指定路径。 */
  navigate(path: string): void;
  /** 发送通知。 */
  notify(title: string, body?: string): void;
  /** 解码模块 token payload（不验签，仅展示用）。 */
  decodeContext(token: string): ModuleTokenClaims;
}

/**
 * 解码 JWT payload：base64url → UTF-8 → JSON。不验签，仅展示用。
 */
export function decodeJwtPayload(token: string): unknown {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed token: expected 3 parts');
  }
  const payload = parts[1];
  if (!payload) {
    throw new Error('malformed token: empty payload');
  }
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * 创建模块侧 SDK 客户端。
 * 所有 window 访问均在运行时做 typeof 守卫，便于非浏览器环境与测试。
 */
export function createModuleSDK(options: CreateModuleSDKOptions): ModuleSDK {
  const { moduleId, coreOrigin } = options;
  // M0：moduleId 仅保留，供 M1 握手上下文使用。
  void moduleId;

  const targetOrigin = coreOrigin ?? '*';

  const postToParent = (message: unknown): void => {
    if (typeof window === 'undefined') {
      return;
    }
    window.parent.postMessage(message, targetOrigin);
  };

  return {
    ready(): void {
      postToParent({ type: 'ready' });
    },
    waitForToken(): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        if (typeof window === 'undefined') {
          reject(new Error('module-sdk: window is not available'));
          return;
        }
        const onMessage = (event: MessageLikeEvent): void => {
          // 信任的 origin 校验：未配置 coreOrigin 时接受任意来源（* 语义）。
          if (coreOrigin !== undefined && event.origin !== coreOrigin) {
            return;
          }
          const data = event.data as { type?: unknown; token?: unknown } | null;
          if (data === null || typeof data !== 'object') {
            return;
          }
          if (data.type !== 'token' || typeof data.token !== 'string') {
            return;
          }
          window.removeEventListener('message', onMessage);
          resolve(data.token);
        };
        window.addEventListener('message', onMessage);
      });
    },
    navigate(path: string): void {
      postToParent({ type: 'navigate', path });
    },
    notify(title: string, body?: string): void {
      postToParent(
        body === undefined
          ? { type: 'notify', title }
          : { type: 'notify', title, body },
      );
    },
    decodeContext(token: string): ModuleTokenClaims {
      return ModuleTokenClaimsSchema.parse(decodeJwtPayload(token));
    },
  };
}
