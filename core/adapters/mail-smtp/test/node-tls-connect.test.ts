// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import type { SocketOptions } from 'cloudflare:sockets';

// 确保错误配置的测试绝不联网；若校验被删除，将抛出不同的网络边界错误。
vi.mock('node:tls', () => ({ connect() { throw new Error('Unexpected network access'); } }));
import { nodeTlsConnect } from './node-tls-connect';

describe('Node 真实投递入口的 TLS 约束', () => {
  it.each([undefined, { secureTransport: 'off' }, { secureTransport: 'starttls' }] as Array<SocketOptions | undefined>)(
    '未显式启用隐式 TLS 时拒绝发起连接（%j）', (options) => {
      expect(() => nodeTlsConnect({ hostname: 'mail.example.com', port: 465 }, options))
        .toThrow('真实投递测试要求在 options 中显式启用隐式 TLS');
    },
  );

  it('TLS 选项只写入地址也不能绕过保护', () => {
    const legacyAddress = { hostname: 'mail.example.com', port: 465, secureTransport: 'on' };
    expect(() => nodeTlsConnect(legacyAddress))
      .toThrow('真实投递测试要求在 options 中显式启用隐式 TLS');
  });
});
