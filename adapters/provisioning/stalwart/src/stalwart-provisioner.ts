// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stalwart 0.16 MailProvisioner 实现（JMAP 对象协议，POST /jmap）。
 * 设计依据：docs/PRODUCT_SPEC.md §6.6 决策表 + §5.7 末段 Stalwart 适配事实。
 * 只实现四方法；错误处理仅在 JMAP 调用边界，不做重试/缓存/批量优化。
 */

import type {
  CreateMailAccountInput,
  CreateMailAccountOutput,
  MailAccountEmailInput,
  MailProvisioner,
  ResetMailAccountPasswordInput,
} from '@unself/contracts';
import {
  postJmap,
  requireResponse,
  requireSetSuccess,
  type JmapMethodCall,
  type JmapResponse,
} from './jmap.ts';

/** 邮箱开户错误码：只覆盖真实错误面中被调用方需要区分的两种。 */
export type MailProvisionerErrorCode = 'ACCOUNT_EXISTS' | 'ACCOUNT_NOT_FOUND';

/** 携带错误码的开户失败；#18/#17 按需消费 code。 */
export class MailProvisionerError extends Error {
  readonly code: MailProvisionerErrorCode;

  constructor(code: MailProvisionerErrorCode, message: string) {
    super(message);
    this.name = 'MailProvisionerError';
    this.code = code;
  }
}

/** mail 段配置（unself.config / instance_config `mail` 键）。 */
export interface StalwartProvisionerConfig {
  /** Stalwart 管理接口根地址，如 https://mail.example.com */
  baseUrl: string;
  /** Stalwart API key（Bearer，最小权限集） */
  apiKey: string;
  /** 工作邮箱域名，如 example.com（部署配置项，非运行时手填） */
  domain: string;
}

/** 账户名 = email 前缀（Stalwart Account.name 为 EmailLocalPart）。 */
function accountName(email: string): string {
  const at = email.indexOf('@');
  return at === -1 ? email : email.slice(0, at);
}

/** WebCrypto 生成随机初始密码（Workers/Node 22+ 均内置）。 */
async function randomPassword(length = 24): Promise<string> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let password = '';
  for (const byte of bytes) {
    password += alphabet[byte % alphabet.length]!;
  }
  return password;
}

/**
 * x:Account/query 的 name 过滤按前缀匹配，单个响应里再按 emails 精确对上。
 * 查无此人抛 ACCOUNT_NOT_FOUND。
 */
async function requireAccountId(
  post: (calls: JmapMethodCall[]) => Promise<JmapResponse>,
  email: string,
): Promise<string> {
  const jmap = await post([
    ['x:Account/query', { filter: { name: accountName(email) } }, 'q'],
    [
      'x:Account/get',
      { '#ids': { resultOf: 'q', name: 'x:Account/query', path: '/ids' } },
      'g',
    ],
  ]);
  const getBody = requireResponse(jmap, 'g');
  const list = (getBody['list'] as Array<Record<string, unknown>> | undefined) ?? [];
  for (const account of list) {
    const emails = account['emails'];
    if (Array.isArray(emails) && emails.includes(email)) {
      return account['id'] as string;
    }
  }
  throw new MailProvisionerError('ACCOUNT_NOT_FOUND', `Stalwart 中找不到账户 ${email}`);
}

/** 摘掉（disable）或恢复（enable）authenticate 权限位——可逆禁用语义，不删号。 */
function authenticatePermissionPatch(disable: boolean): Record<string, unknown> {
  if (disable) {
    return {
      permissions: {
        '@type': 'Replace',
        enabledPermissions: [],
        disabledPermissions: ['authenticate'],
      },
    };
  }
  // 恢复继承默认权限，等于把显式禁用位摘掉。
  return { permissions: { '@type': 'Inherit' } };
}

export function createStalwartMailProvisioner(
  config: StalwartProvisionerConfig,
): MailProvisioner {
  const post = (calls: JmapMethodCall[]): Promise<JmapResponse> =>
    postJmap(config.baseUrl, config.apiKey, calls);

  return {
    async createAccount(input: CreateMailAccountInput): Promise<CreateMailAccountOutput> {
      // 先 x:Domain/query 拿 domainId（0.16 文档口径），再建号。
      const domainJmap = await post([
        ['x:Domain/query', { filter: { name: config.domain } }, 'd'],
      ]);
      const domainBody = requireResponse(domainJmap, 'd');
      const domainId = ((domainBody['ids'] as string[] | undefined) ?? [])[0];
      if (!domainId) {
        throw new Error(`Stalwart 中没有域名 ${config.domain}：请先在 Stalwart 配置该邮箱域名`);
      }

      const email = `${input.emailPrefix}@${config.domain}`;
      const password = await randomPassword();
      const createJmap = await post([
        [
          'x:Account/set',
          {
            create: {
              new1: {
                '@type': 'User',
                name: input.emailPrefix,
                domainId,
                credentials: [{ '@type': 'Password', secret: password }],
                roles: { '@type': 'User' },
                permissions: { '@type': 'Inherit' },
                aliases: [],
                memberGroupIds: [],
                quotas: {},
                encryptionAtRest: { '@type': 'Disabled' },
              },
            },
          },
          'c',
        ],
      ]);
      requireSetSuccess(requireResponse(createJmap, 'c'), 'createAccount', 'new1');
      return { email };
    },

    async disableAccount({ email }: MailAccountEmailInput): Promise<void> {
      const accountId = await requireAccountId(post, email);
      const jmap = await post([
        [
          'x:Account/set',
          { update: { [accountId]: authenticatePermissionPatch(true) } },
          'u',
        ],
      ]);
      requireSetSuccess(requireResponse(jmap, 'u'), 'disableAccount', accountId);
    },

    async enableAccount({ email }: MailAccountEmailInput): Promise<void> {
      const accountId = await requireAccountId(post, email);
      const jmap = await post([
        [
          'x:Account/set',
          { update: { [accountId]: authenticatePermissionPatch(false) } },
          'u',
        ],
      ]);
      requireSetSuccess(requireResponse(jmap, 'u'), 'enableAccount', accountId);
    },

    async resetPassword({ email, password }: ResetMailAccountPasswordInput): Promise<void> {
      const accountId = await requireAccountId(post, email);
      const jmap = await post([
        [
          'x:Account/set',
          {
            update: {
              [accountId]: {
                credentials: [{ '@type': 'Password', secret: password }],
              },
            },
          },
          'u',
        ],
      ]);
      requireSetSuccess(requireResponse(jmap, 'u'), 'resetPassword', accountId);
    },
  };
}
