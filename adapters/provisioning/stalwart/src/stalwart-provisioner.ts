// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stalwart 0.16 MailProvisioner 实现（JMAP 对象协议，POST /jmap）。
 * 设计依据：docs/PRODUCT_SPEC.md §6.6 决策表 + §5.7 末段 Stalwart 适配事实。
 * 只实现四方法；错误处理仅在 JMAP 调用边界，不做重试/缓存/批量优化。
 *
 * #141 分层归位：错误契约（MailProvisionerError/Code）与内存假实现全部上提
 * @unself/contracts，本包只剩协议细节；同名符号从本包 re-export，
 * 外部导入路径不变（tests/core-api 存量 import 零改动）。
 */

import type {
  CreateMailAccountInput,
  CreateMailAccountOutput,
  MailAccountEmailInput,
  MailProvisioner,
  ResetMailAccountPasswordInput,
} from '@unself/contracts';

export {
  createFakeMailProvisioner,
  type FakeMailCall,
  type FakeMailProvisioner,
  MailProvisionerError,
  type MailProvisionerErrorCode,
} from '@unself/contracts';
import { MailProvisionerError } from '@unself/contracts';
import {
  postJmap,
  requireResponse,
  requireSetSuccess,
  type JmapMethodCall,
  type JmapResponse,
} from './jmap.ts';

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
 * reset 凭据映射用的数字索引键（0.16.20 实测定案，issue #148）。
 * 0.16.20 起 User.credentials 属性是【索引 List】：patch 的 map 键必须可 parse::<u32>()，
 * 随机字母数字键会被拒 invalidPatch「Invalid key for object property」（生产实测三形状对照：
 * 随机键 ✗、现存 credentialId 字母键 ✗、数字键 "0" → updated ✓）。
 * 0.16.17 历史形状（issue #113）为随机字母数字新键，升 0.16.20 后失效——停机设密码 500 的根因。
 */
function credentialPatchKey(): string {
  return '0';
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

/**
 * 摘掉（disable）或恢复（enable）authenticate 权限位——可逆禁用语义，不删号。
 * disable 形状 = 上游 SCIM set_active 的禁用形状（crates/scim/src/users/mod.rs）：
 * Permissions::Merge + disabledPermissions map。0.16.20 实测：Merge + {authenticate: true} → updated，
 * 该账号 Basic 登录 403、permissions 回读 {Merge, disabled:{authenticate:true}}，Inherit 恢复后 200。
 * 旧形状（0.16.17 写下的数组 enabledPermissions: [] / disabledPermissions: ['authenticate']）
 * 实测 invalidPatch「Invalid value for object property (permissions/enabledPermissions)」——
 * PermissionsList 两字段是 Map<Permission>（0.16.17→0.16.20 map.rs 未变，数组从来不是合法形状），
 * 本次一并修正（issue #148）。
 */
function authenticatePermissionPatch(disable: boolean): Record<string, unknown> {
  if (disable) {
    return {
      permissions: {
        '@type': 'Merge',
        enabledPermissions: {},
        disabledPermissions: { authenticate: true },
      },
    };
  }
  // 恢复继承默认权限，等于把显式禁用位摘掉（0.16.20 实测：Inherit → updated，登录 200）。
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
            // 载荷形状照 0.16.17 实测定案（issue #113）、0.16.20 复测通过（issue #148）：
            // credentials 必须键控对象（数组被拒 invalidPatch），键 '1' 是纯数字，
            // 在 0.16.20 的索引 List 下幸存（实测 create → created）；credentialId 为 serverSet，
            // create 不可带。aliases/memberGroupIds 是 objectList/set 类型，必须传 {} 而非 []。
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
              // 定案形状（0.16.20 实测，issue #148）：credentials 是索引 List，patch 键必须数字
              // 索引（随机/字母键 invalidPatch）。0.16.17 历史形状（issue #113）为随机字母数字新键，
              // 升 0.16.20 后失效；整 map 替换 / JMAP "/" patch / 数组形状均被拒。
              [accountId]: {
                credentials: {
                  [credentialPatchKey()]: { '@type': 'Password', secret: password },
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
