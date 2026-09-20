// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stalwart 0.16 MailProvisioner 实现（JMAP 对象协议，POST /jmap）。
 * 设计依据：docs/PRODUCT_SPEC.md §6.6 决策表 + §5.7 末段 Stalwart 适配事实。
 * 只实现四方法；错误处理仅在 JMAP 调用边界，不做重试/缓存/批量优化。
 *
 * #141 分层归位：错误契约（MailProvisionerError/Code）与内存假实现全部上提
 * @unself/contracts，本包只剩协议细节；同名符号从本包 re-export，
 * 外部导入路径不变（tests/core-api 存量 import 零改动）。
 *
 * #189：B1 边界失败全抛结构化 code/httpStatus；B2 停用/启用先读 permissions 再只改
 * authenticate 位（读-改-写）；B4 displayName 写 User.description；B5 四方法整体 10s 超时。
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
  type MailProvisionerErrorOptions,
} from '@unself/contracts';
import { MailProvisionerError } from '@unself/contracts';
import {
  DEFAULT_JMAP_TIMEOUT_MS,
  postJmap,
  requireResponse,
  requireSetSuccess,
  withJmapTimeout,
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
  /** 单方法超时（ms），缺省 10s（#189 B5，与 mail-test 探测器同口径；可随 mail 配置覆盖）。 */
  timeoutMs?: number;
}

/**
 * mail 段配置的边界校验（#303：组合根从 installer 的生成式入口搬进包内后暴露）。
 *
 * 过去入口是 JS，`CreateMailProvisioner = (mailConfig: unknown)` 的 `unknown` 会**原样漏进**适配器，
 * 缺 baseUrl/apiKey/domain 时报错发生在深处（拿 undefined 拼 URL），看不出病因。
 * 这里在唯一入口收口：形状不对就**当场**抛结构化失败（同 `permissionMap` 口径：看不懂的配置绝不猜）。
 */
export function toStalwartProvisionerConfig(raw: unknown): StalwartProvisionerConfig {
  const source: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const requireString = (key: 'baseUrl' | 'apiKey' | 'domain'): string => {
    const value = source[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new MailProvisionerError('UPSTREAM_FAILURE', `Stalwart 配置缺失 ${key}（unself.config 的 mail 段）`);
    }
    return value;
  };
  const config: StalwartProvisionerConfig = {
    baseUrl: requireString('baseUrl'),
    apiKey: requireString('apiKey'),
    domain: requireString('domain'),
  };
  if (typeof source['timeoutMs'] === 'number') {
    config.timeoutMs = source['timeoutMs'];
  }
  return config;
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
 * 账号权限的线上形状（0.16 上游 schema：`Permissions = Inherit | Merge(PermissionsList) | Replace(PermissionsList)`，
 * `PermissionsList` 两表是 `Map<Permission, bool>`：键即权限名，值读回时是布尔）。
 */
export type StalwartPermissions =
  | { '@type': 'Inherit' }
  | {
      '@type': 'Merge' | 'Replace';
      enabledPermissions: Record<string, boolean>;
      disabledPermissions: Record<string, boolean>;
    };

/** 权限表形状校验：非对象/非布尔值一律报错，绝不把看不懂的配置当空表回写。 */
function permissionMap(raw: unknown, field: string): Record<string, boolean> {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MailProvisionerError(
      'UPSTREAM_FAILURE',
      `Stalwart 账号 permissions.${field} 不是对象：${JSON.stringify(raw)}`,
    );
  }
  const map: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'boolean') {
      throw new MailProvisionerError(
        'UPSTREAM_FAILURE',
        `Stalwart 账号 permissions.${field}.${key} 不是布尔值：${JSON.stringify(value)}`,
      );
    }
    map[key] = value;
  }
  return map;
}

/** 把 x:Account/get 读回的 permissions 规整成可回写的形状；缺省/缺字段按 Inherit，异形报错不猜。 */
export function parsePermissions(raw: unknown): StalwartPermissions {
  if (raw === undefined || raw === null) {
    return { '@type': 'Inherit' };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    const type = value['@type'];
    if (type === 'Inherit') {
      return { '@type': 'Inherit' };
    }
    if (type === 'Merge' || type === 'Replace') {
      return {
        '@type': type,
        enabledPermissions: permissionMap(value['enabledPermissions'], 'enabledPermissions'),
        disabledPermissions: permissionMap(value['disabledPermissions'], 'disabledPermissions'),
      };
    }
  }
  throw new MailProvisionerError(
    'UPSTREAM_FAILURE',
    `Stalwart 账号 permissions 形状无法识别：${JSON.stringify(raw)}`,
  );
}

/**
 * 读-改-写（#189 B2）：停用/启用只动 authenticate 位，其余显式权限原样保留。
 *
 * 真机实测（issue #189）：旧实现停用/启用时整表覆写 permissions——显式
 * `Merge{enabled:{authenticate:true}}` 的账号经 disable 后显式位丢失，enable 后回 `Inherit`。
 * 现改为先 `x:Account/get` 读回当前 permissions（requireAccount），再按下面规则改完回写。
 *
 * 上游权限语义（0.16 源码 crates/common/src/auth/permissions.rs + 官方 Permissions 文档）：
 * - `Inherit` 全用角色继承集；`Merge` 自身 enabled 与角色集合并集；`Replace` 自身 enabled 取代角色集；
 * - 最终权限 = `PermissionsGroup::finalize()` = enabled − disabled（access_token.rs 建令牌时调用），
 *   所以 disabled 恒优先（同一权限同时在两表里 = 禁用），最后统一减去 disabledPermissions；
 *   注：PermissionsList 只看【键】是否在表里（上游 `From<PermissionsList>` 取 `as_slice()`），
 *   键上的布尔值不参与判定，所以本函数的「原来禁用了吗」也按键是否存在算。
 *
 * 收放规则（与上游 SCIM set_active 同口径 + 验收 #2 的无损要求）：
 * - 停用：只把 authenticate 记进 disabled，enabled 表一个键都不动——管理员原有显式权限
 *   （包括原 enabled 里的 authenticate）全部保留；登录由 finalize 的 disabled 优先真正停掉。
 * - 启用（Merge）：摘掉 disabled.authenticate；摘完两表皆空（原本 Inherit 的账号）写回 Inherit。
 * - 启用（Replace）：角色集在这个模式下被忽略，所以必须显式补回 enabled.authenticate，
 *   否则「点启用」只摘掉禁用标记、账号仍登录不了（上游 set_active 的
 *   replace_grants_authenticate_on_activation 就是为这个）；Replace 不塌回 Inherit（上游有测圮）。
 */
export function authenticatePermissionPatch(
  current: StalwartPermissions,
  disable: boolean,
): StalwartPermissions {
  if (current['@type'] === 'Inherit') {
    // 0.16.20 实测可用形状（同上游 SCIM set_active 的禁用形状）：Merge + disabled.authenticate。
    return disable
      ? { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: { authenticate: true } }
      : { '@type': 'Inherit' };
  }
  const enabledPermissions = { ...current.enabledPermissions };
  const disabledPermissions = { ...current.disabledPermissions };
  if (disable) {
    disabledPermissions['authenticate'] = true;
    return { '@type': current['@type'], enabledPermissions, disabledPermissions };
  }
  delete disabledPermissions['authenticate'];
  if (current['@type'] === 'Replace') {
    enabledPermissions['authenticate'] = true;
    return { '@type': 'Replace', enabledPermissions, disabledPermissions };
  }
  if (Object.keys(enabledPermissions).length === 0 && Object.keys(disabledPermissions).length === 0) {
    // 两表皆空 = 与 Inherit 同义（上游 set_active 同口径）
    return { '@type': 'Inherit' };
  }
  return { '@type': current['@type'], enabledPermissions, disabledPermissions };
}

/**
 * 定位账号并读回权限（#189 B2 读-改-写）：x:Account/query 的 name 过滤是【精确匹配】
 * （0.16.17 实测：查 no-repl 无结果、no-reply 命中，并非前缀匹配），再用 JMAP 结果引用
 * 在同一请求里 get（旧实现 #113 用过同形状 get，服务端支持 '#ids' 引用）。
 * 查得 0 个 id → ACCOUNT_NOT_FOUND；get 未回该账号 → 报错不猜（宁可不改也不覆盖）。
 */
async function requireAccount(
  post: (calls: JmapMethodCall[]) => Promise<JmapResponse>,
  email: string,
): Promise<{ id: string; permissions: StalwartPermissions }> {
  const jmap = await post([
    ['x:Account/query', { filter: { name: accountName(email) } }, 'q'],
    ['x:Account/get', { '#ids': { resultOf: 'q', name: 'x:Account/query', path: '/ids' } }, 'g'],
  ]);
  const body = requireResponse(jmap, 'q');
  const ids = (body['ids'] as string[] | undefined) ?? [];
  const accountId = ids[0];
  if (!accountId) {
    throw new MailProvisionerError('ACCOUNT_NOT_FOUND', `Stalwart 中找不到账户 ${email}`);
  }
  const list = (requireResponse(jmap, 'g')['list'] as Array<Record<string, unknown>> | undefined) ?? [];
  const account = list.find((item) => item['id'] === accountId);
  if (!account) {
    throw new MailProvisionerError(
      'UPSTREAM_FAILURE',
      `Stalwart 账号 ${email} 的 permissions 读取失败：x:Account/get 未返回该账号`,
    );
  }
  return { id: accountId, permissions: parsePermissions(account['permissions']) };
}

export function createStalwartMailProvisioner(
  config: StalwartProvisionerConfig,
): MailProvisioner {
  const timeoutMs = config.timeoutMs ?? DEFAULT_JMAP_TIMEOUT_MS;
  const post = (calls: JmapMethodCall[]): Promise<JmapResponse> =>
    postJmap(config.baseUrl, config.apiKey, calls, { timeoutMs });
  /** 单方法整体时限（#189 B5）：一个方法内串多次 JMAP 请求也不得超过 timeoutMs。 */
  const run = <T>(method: string, operation: () => Promise<T>): Promise<T> =>
    withJmapTimeout(operation, `JMAP ${method} 调用`, timeoutMs);

  return {
    createAccount: (input: CreateMailAccountInput): Promise<CreateMailAccountOutput> =>
      run('createAccount', async () => {
        // 先 x:Domain/query 拿 domainId（0.16 文档口径），再建号。
        const domainJmap = await post([
          ['x:Domain/query', { filter: { name: config.domain } }, 'd'],
        ]);
        const domainBody = requireResponse(domainJmap, 'd');
        const domainId = ((domainBody['ids'] as string[] | undefined) ?? [])[0];
        if (!domainId) {
          throw new MailProvisionerError(
            'UPSTREAM_FAILURE',
            `Stalwart 中没有域名 ${config.domain}：请先在 Stalwart 配置该邮箱域名`,
          );
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
                  // displayName 落 Stalwart User.description（0.16 schema 字段），与假实现
                  // 内存里的 displayName 语义对齐（#189 B4）。
                  description: input.displayName,
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
      }),

    disableAccount: ({ email }: MailAccountEmailInput): Promise<void> =>
      run('disableAccount', async () => {
        // 读-改-写（#189 B2）：先读回当前 permissions，只改 authenticate 位再回写。
        const account = await requireAccount(post, email);
        const permissions = authenticatePermissionPatch(account.permissions, true);
        const jmap = await post([
          ['x:Account/set', { update: { [account.id]: { permissions } } }, 'u'],
        ]);
        requireSetSuccess(requireResponse(jmap, 'u'), 'disableAccount', account.id);
      }),

    enableAccount: ({ email }: MailAccountEmailInput): Promise<void> =>
      run('enableAccount', async () => {
        // 读-改-写（#189 B2）：只摘掉 disabled.authenticate，其余显式权限不回退。
        const account = await requireAccount(post, email);
        const permissions = authenticatePermissionPatch(account.permissions, false);
        const jmap = await post([
          ['x:Account/set', { update: { [account.id]: { permissions } } }, 'u'],
        ]);
        requireSetSuccess(requireResponse(jmap, 'u'), 'enableAccount', account.id);
      }),

    resetPassword: ({ email, password }: ResetMailAccountPasswordInput): Promise<void> =>
      run('resetPassword', async () => {
        const account = await requireAccount(post, email);
        const jmap = await post([
          [
            'x:Account/set',
            {
              update: {
                // 定案形状（0.16.20 实测，issue #148）：credentials 是索引 List，patch 键必须数字
                // 索引（随机/字母键 invalidPatch）。0.16.17 历史形状（issue #113）为随机字母数字新键，
                // 升 0.16.20 后失效；整 map 替换 / JMAP "/" patch / 数组形状均被拒。
                [account.id]: {
                  credentials: {
                    [credentialPatchKey()]: { '@type': 'Password', secret: password },
                  },
                },
              },
            },
            'u',
          ],
        ]);
        requireSetSuccess(requireResponse(jmap, 'u'), 'resetPassword', account.id);
      }),
  };
}
