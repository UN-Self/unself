// SPDX-License-Identifier: AGPL-3.0-only
//
// cloudflare:sockets 的最小类型声明（仅本包用到的 connect 面）。
// 运行时由 workerd 提供；本地 vitest 不加载真实模块（单测走 socket mock，
// 冒烟走 wrangler dev 由 workerd 解析）。避免整包 @cloudflare/workers-types
// 与 web 标准 lib 冲突（同 services/core-api 口径：包内自定义边界类型）。
declare module 'cloudflare:sockets' {
  export interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly opened: Promise<unknown>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
    startTls(options?: { expectedServerHostname?: string }): Socket;
  }

  export function connect(
    address: { hostname: string; port: number; secureTransport?: 'off' | 'startTLS' | 'on' },
    options?: { allowHalfOpen?: boolean },
  ): Socket;
}
