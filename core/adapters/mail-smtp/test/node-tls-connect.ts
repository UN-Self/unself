// SPDX-License-Identifier: AGPL-3.0-only
import { connect as tlsConnect } from 'node:tls';
import { Readable, Writable } from 'node:stream';
import type { Socket } from 'cloudflare:sockets';
import type { Connect } from '../src/smtp';

/**
 * node:tls 连接工厂：把 Node 的 TLS socket 适配成 cloudflare:sockets 的 Socket 面，
 * 让 sendMail 在纯 Node 环境也能走真实 465 隐式 TLS 投递（仅测试边界使用）。
 */
export const nodeTlsConnect: Connect = (address, options) => {
  if (options?.secureTransport !== 'on') {
    throw new Error('真实投递测试要求在 options 中显式启用隐式 TLS');
  }
  if (typeof address === 'string') {
    throw new Error('真实投递测试要求 hostname/port 地址');
  }
  const socket = tlsConnect({ host: address.hostname, port: address.port, servername: address.hostname });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', () => {
      socket.removeListener('error', reject);
      resolve();
    });
    socket.once('error', reject);
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const adapter: Socket = {
    readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(socket) as WritableStream<Uint8Array>,
    opened,
    closed,
    close: async () => {
      socket.destroy();
    },
    startTls: () => {
      throw new Error('465 隐式 TLS 不用 startTls');
    },
  };
  return adapter;
};


