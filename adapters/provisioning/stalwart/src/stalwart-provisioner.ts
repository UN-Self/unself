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
 * reset 凭据映射用的随机新键——每次 reset 换新键，不与现存 credentialId 撞键。
 * 服务端语义：map 出现新键 = 追加同 type 凭据并替换旧的（0.16.17 实测：凭据列表回到单条、旧密码 401）。
 */
function randomCredentialKey(length = 12): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let key = '';
  for (const byte of bytes) {
    key += alphabet[byte % alphabet.length]!;
  }
  return key;
}

/**
 * x:Account/query 的 name 过滤是【精确匹配】（0.16.17 实测：查 no-repl 无结果、no-reply 命中，
 * 并非前缀匹配）。查得 0 个 id → ACCOUNT_NOT_FOUND；≥1 个直接取第一个（精确匹配下不会有歧义）。
 * 不读账号对象的 emails 字段——该版本账号对象无 emails（schema 仅 serverSet 的 emailAddress，GET 不回）。
 */
async function requireAccountId(
  post: (calls: JmapMethodCall[]) => Promise<JmapResponse>,
  email: string,
): Promise<string> {
  const jmap = await post([['x:Account/query', { filter: { name: accountName(email) } }, 'q']]);
  const body = requireResponse(jmap, 'q');
  const ids = (body['ids'] as string[] | undefined) ?? [];
  const accountId = ids[0];
  if (!accountId) {
    throw new MailProvisionerError('ACCOUNT_NOT_FOUND', `Stalwart 中找不到账户 ${email}`);
  }
  return accountId;
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
            // 载荷形状照 0.16.17 实测定案（issue #113）：credentials 必须键控对象
            // （数组被拒 invalidPatch；credentialId 为 serverSet，create 不可带，键名任意）；
            // aliases/memberGroupIds 是 objectList/set 类型，必须传 {} 而非 []。
            create: {
              new1: {
                '@type': 'User',
                name: input.emailPrefix,
                domainId,
                credentials: { '1': { '@type': 'Password', secret: password } },
                roles: { '@type': 'User' },
                permissions: { '@type': 'Inherit' },
                aliases: {},
                memberGroupIds: {},
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
              // 定案形状（0.16.17 实测）：credentials 键控对象 + 随机新键 = 追加并替换同 type 旧凭据。
              // 整 map 替换 / JMAP "/" patch / 数组形状均被拒（notRequest、notFound、invalidPatch）。
              [accountId]: {
                credentials: {
                  [randomCredentialKey()]: { '@type': 'Password', secret: password },
                },
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
