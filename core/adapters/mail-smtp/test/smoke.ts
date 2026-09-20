// SPDX-License-Identifier: AGPL-3.0-only
//
// TCP 465 隐式 TLS 冒烟（issue #48 拍板：开工第一件事）。
// 只做一件事：cloudflare:sockets connect() secureTransport:'on' → 465 端口 →
// 期待 SMTP 服务器 220 问候语。
// 跑法：pnpm --filter @unself/mail-smtp test:smoke，然后 GET http://localhost:8787/?host=mail.unself.cn
import { connect } from 'cloudflare:sockets';

async function smoke(host: string): Promise<string> {
  const socket = connect({ hostname: host, port: 465, secureTransport: 'on' });
  const reader = socket.readable.getReader();

  // 服务器问候语：465 隐式 TLS 下 connect() 成功即已完成 TLS 握手，
  // 第一段可读数据必须是 SMTP "220 ..."（读一段即够，不进命令序列）。
  const { value } = await reader.read();
  await socket.close().catch(() => {});

  const greeting = new TextDecoder().decode(value);
  if (!greeting.startsWith('220')) {
    throw new Error(`465 冒烟失败：非 220 问候语 → ${JSON.stringify(greeting.slice(0, 120))}`);
  }
  return `${host}:465 隐式 TLS 握手 OK，问候语：${greeting.trim().slice(0, 80)}`;
}

// connect() 等异步 I/O 只能发生在 handler 内（workerd 禁止全局作用域异步 I/O），
// 故冒烟逻辑放进 fetch handler；ESM 默认导出也让 wrangler 按 module 格式装载。
export default {
  async fetch(request: Request): Promise<Response> {
    // wrangler dev 注入不了 process.env；SMTP_HOST 用 URL query 或 wrangler var 传，默认团队参考邮局
    const host =
      new URL(request.url).searchParams.get('host') ??
      (globalThis as { SMTP_HOST?: string }).SMTP_HOST ??
      'mail.unself.cn';
    try {
      const result = await smoke(host);
      console.log(`[smoke] ${result}`);
      return new Response(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[smoke] ${msg}`);
      return new Response(msg, { status: 500 });
    }
  },
};
