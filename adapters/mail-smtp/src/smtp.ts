// SPDX-License-Identifier: AGPL-3.0-only
//
// SMTP 发信客户端（465 隐式 TLS，单一路径）：
//   连接 → 220 问候 → EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA → QUIT
// 不做 STARTTLS/587、队列、重试、附件、抄送。错误只在会话边界抛人话 Error（含状态码）。
import type { Socket, connect as CloudflareConnect } from 'cloudflare:sockets';

/** SMTP 连接配置（来自实例配置 mail 段）。 */
export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  /** 发件地址（mustMatchSender 专用发件账户，如 no-reply@mail.example.com）。 */
  from: string;
}

/** 一封纯文本邮件。 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** SMTP 单条应答。 */
interface Reply {
  code: number;
  text: string;
}

/** 逐行读取 SMTP 应答（跨 TCP 分包缓冲）。 */
class LineReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = '';

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async readLine(): Promise<string> {
    for (;;) {
      const newlineAt = this.#buffer.indexOf('\n');
      if (newlineAt >= 0) {
        const line = this.#buffer.slice(0, newlineAt).replace(/\r$/, '');
        this.#buffer = this.#buffer.slice(newlineAt + 1);
        return line;
      }
      const { done, value } = await this.#reader.read();
      if (done) {
        throw new Error('SMTP 连接中断：等待服务器响应时连接被关闭');
      }
      this.#buffer += decoder.decode(value, { stream: true });
    }
  }
}

/** 读一条完整 SMTP 应答（多行以 "250-…" 延续，末行第 4 字符为空格）。 */
async function readReply(reader: LineReader): Promise<Reply> {
  let code = 0;
  let text = '';
  for (;;) {
    const line = await reader.readLine();
    if (!/^\d{3}[ -]/.test(line)) {
      throw new Error(`SMTP 响应格式异常：${JSON.stringify(line.slice(0, 80))}`);
    }
    code = Number(line.slice(0, 3));
    text += (text ? ' / ' : '') + line.slice(4);
    if (line[3] === ' ') {
      return { code, text };
    }
  }
}

/** 发一条命令（可空）并校验应答码落在 [codeMin, codeMax]；越界抛人话 Error。 */
async function command(
  reader: LineReader,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  line: string | null,
  codeMin: number,
  codeMax: number,
  errorPrefix: string,
): Promise<Reply> {
  if (line !== null) {
    await writer.write(encoder.encode(`${line}\r\n`));
  }
  const reply = await readReply(reader);
  if (reply.code < codeMin || reply.code > codeMax) {
    throw new Error(`${errorPrefix}（${reply.code}）：${reply.text}`);
  }
  return reply;
}

/** UTF-8 → base64（分块转字符串，避免长正文撑爆 String.fromCharCode 调用栈）。 */
function base64Utf8(text: string): string {
  const bytes = encoder.encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** 头部中文按 RFC 2047 encoded-word（base64）编码，保证中文 Subject 正确送达。 */
function encodedWord(text: string): string {
  return `=?utf-8?B?${base64Utf8(text)}?=`;
}

/** 正文 base64 并按 RFC 2045 折行（≤76 字符），保证中文正文正确送达。 */
function base64Body(text: string): string {
  return base64Utf8(text).replace(/(.{76})/g, '$1\r\n');
}

/** 组装 DATA 载荷：头 + 空行 + base64 正文。 */
function buildDataPayload(config: SmtpConfig, message: MailMessage): string {
  const headers = [
    `From: ${config.from}`,
    `To: ${message.to}`,
    `Subject: ${encodedWord(message.subject)}`,
    `Date: ${new Date().toUTCString().replace(/ GMT$/, ' +0000')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  return [...headers, '', base64Body(message.text)].join('\r\n');
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 可注入的连接工厂（生产走 cloudflare:sockets，测试注入 socket mock）。 */
export type Connect = typeof CloudflareConnect;

/**
 * 发一封纯文本邮件（465 隐式 TLS）。投递成功即返回；任何会话边界失败抛人话 Error。
 */
export async function sendMail(
  config: SmtpConfig,
  message: MailMessage,
  connectFn?: Connect,
): Promise<void> {
  // 惰性加载 workerd 内置模块：仅真实发信路径触发，单测注入 mock 后不触碰该模块。
  const connectImpl = connectFn ?? (await import('cloudflare:sockets')).connect;
  let socket: Socket;
  try {
    socket = connectImpl({ hostname: config.host, port: config.port, secureTransport: 'on' });
    await socket.opened;
  } catch (cause) {
    throw new Error(
      `SMTP 连接失败：无法连接 ${config.host}:${config.port} —— ${errorMessage(cause)}`,
    );
  }

  const reader = new LineReader(socket.readable);
  const writer = socket.writable.getWriter();
  // EHLO 域名取自发件地址域名（mail.domain），不新增配置字段。
  const ehloDomain = config.from.split('@')[1] ?? 'unself';
  const payload = buildDataPayload(config, message).replace(/\r\n$/, '');

  try {
    await command(reader, writer, null, 220, 220, 'SMTP 连接失败：服务器问候异常');
    await command(reader, writer, `EHLO ${ehloDomain}`, 250, 299, 'SMTP 会话失败：EHLO 被拒');
    await command(reader, writer, 'AUTH LOGIN', 334, 334, 'SMTP 认证失败');
    await command(reader, writer, base64Utf8(config.username), 334, 334, 'SMTP 认证失败');
    await command(reader, writer, base64Utf8(config.password), 235, 235, 'SMTP 认证失败');
    await command(reader, writer, `MAIL FROM:<${config.from}>`, 250, 299, 'SMTP 投递被拒：MAIL FROM 被拒');
    await command(reader, writer, `RCPT TO:<${message.to}>`, 250, 299, 'SMTP 投递被拒：收件人被拒');
    await command(reader, writer, 'DATA', 354, 354, 'SMTP 投递被拒：DATA 被拒');
    await command(reader, writer, `${payload}\r\n.`, 250, 299, 'SMTP 投递被拒：消息被拒');
    await writer.write(encoder.encode('QUIT\r\n')).catch(() => {});
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // 锁已释放则忽略
    }
    await socket.close().catch(() => {});
  }
}
