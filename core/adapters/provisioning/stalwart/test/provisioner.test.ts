// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JMAP_TIMEOUT_MS, postJmap, requireResponse, requireSetSuccess } from '../src/jmap.ts';
import {
  MailProvisionerError,
  createStalwartMailProvisioner,
  parsePermissions,
  type StalwartProvisionerConfig,
} from '../src/stalwart-provisioner.ts';
import { createFakeMailProvisioner } from '../src/fake.ts';
import type { JmapMethodResponse } from '../src/jmap.ts';
import { MailProvisionerError as MailProvisionerErrorFromContracts } from '@unself/contracts';

const config: StalwartProvisionerConfig = {
  baseUrl: 'https://mail.example.com',
  apiKey: 'sk-1',
  domain: 'example.com',
};

const EMAIL = 'wang@example.com';
const ACCOUNT_ID = 'acc9';

/** 捕获请求体、按 methodCall 顺序回放响应的 fetch mock。 */
function stubFetch(responses: JmapMethodResponse[], status = 200) {
  const bodies: unknown[] = [];
  const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => ({ methodResponses: responses }),
    } as Response;
  });
  vi.stubGlobal('fetch', fetchFn);
  return { fetchFn, bodies };
}

/** query + get 的响应对（disable/enable 读-改-写先读 permissions）。 */
function accountReadResponses(permissions: unknown): JmapMethodResponse[] {
  return [
    ['x:Account/query', { ids: [ACCOUNT_ID] }, 'q'],
    ['x:Account/get', { list: [{ id: ACCOUNT_ID, permissions }] }, 'g'],
  ];
}

/** 从捕获的请求体里取出 x:Account/set 的 update patch。 */
function sentUpdate(body: unknown): Record<string, unknown> {
  const call = (body as { methodCalls: Array<[string, Record<string, unknown>]> }).methodCalls[0]!;
  const update = call[1]['update'] as Record<string, Record<string, unknown>>;
  return update[ACCOUNT_ID]!;
}

/**
 * 带权限状态的 JMAP 假服务器（B2 行为锚点）：get 回当前 permissions，
 * set 按真机行为【整值覆写】permissions——旧实现整表覆盖会在这里丢显式权限。
 */
function permissionsServer(initial: unknown) {
  let permissions = initial;
  const patches: unknown[] = [];
  const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      methodCalls: Array<[string, Record<string, unknown>, string]>;
    };
    const responses: JmapMethodResponse[] = [];
    for (const [name, args, callId] of body.methodCalls) {
      if (name === 'x:Account/query') {
        responses.push([name, { ids: [ACCOUNT_ID] }, callId]);
      } else if (name === 'x:Account/get') {
        responses.push([name, { list: [{ id: ACCOUNT_ID, permissions }] }, callId]);
      } else if (name === 'x:Account/set') {
        const update = (args['update'] as Record<string, Record<string, unknown>>)[ACCOUNT_ID]!;
        patches.push(update['permissions']);
        permissions = update['permissions'];
        responses.push([name, { updated: { [ACCOUNT_ID]: null } }, callId]);
      }
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ methodResponses: responses }),
    } as Response;
  });
  vi.stubGlobal('fetch', fetchFn);
  return { fetchFn, patches, read: () => permissions };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** #141 契约上提守卫：本包 re-export 的错误类就是 contracts 契约本身，非副本。 */
it('MailProvisionerError 与 @unself/contracts 是同一构造器', () => {
  expect(MailProvisionerError).toBe(MailProvisionerErrorFromContracts);
});

describe('postJmap（JMAP client）', () => {
  it('组装 using+methodCalls、Bearer 认证，POST /jmap，解析 methodResponses', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://mail.example.com/jmap');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk-1');
      expect(headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(String(init?.body));
      expect(body.using).toEqual(['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']);
      expect(body.methodCalls).toEqual([['x:Domain/query', { filter: { name: 'example.com' } }, 'd']]);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ methodResponses: [['x:Domain/query', { ids: ['dm1'] }, 'd']] }),
      } as Response;
    }) as unknown as typeof fetch;

    const result = await postJmap(
      'https://mail.example.com/',
      'sk-1',
      [['x:Domain/query', { filter: { name: 'example.com' } }, 'd']],
      { fetchFn },
    );
    expect(result.methodResponses).toEqual([['x:Domain/query', { ids: ['dm1'] }, 'd']]);
  });

  it('凭证缺失：抛结构化 AUTH_FAILED，不发请求（上层按 code 指路，不靠这句文案）', async () => {
    const fetchFn = vi.fn();
    const error = await postJmap('https://x', undefined, [['m', {}, 'c']], {
      fetchFn: fetchFn as unknown as typeof fetch,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'AUTH_FAILED' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('HTTP 403：结构化 code=AUTH_FAILED + httpStatus=403（B1：上层不再靠文案判定）', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const error = await postJmap('https://x', 'k', [['m', {}, 'c']], { fetchFn }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MailProvisionerError);
    expect(error).toMatchObject({ code: 'AUTH_FAILED', httpStatus: 403 });
  });

  it('HTTP 500：结构化 code=UPSTREAM_FAILURE + httpStatus=500（非认证失败也带状态码）', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(postJmap('https://x', 'k', [['m', {}, 'c']], { fetchFn })).rejects.toMatchObject({
      code: 'UPSTREAM_FAILURE',
      httpStatus: 500,
    });
  });

  it('网络失败：抛结构化 UPSTREAM_FAILURE（人话含「网络错误」）', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(postJmap('https://x', 'k', [['m', {}, 'c']], { fetchFn })).rejects.toMatchObject({
      code: 'UPSTREAM_FAILURE',
      message: expect.stringContaining('网络错误'),
    });
  });

  it('响应缺 methodResponses：抛结构化 UPSTREAM_FAILURE', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(postJmap('https://x', 'k', [['m', {}, 'c']], { fetchFn })).rejects.toMatchObject({
      code: 'UPSTREAM_FAILURE',
      message: expect.stringContaining('methodResponses'),
    });
  });

  it('超时（B5）：服务器不响应 10s 后抛 TIMEOUT，并中止底层请求', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {}); // 永不 resolve
    });
    const pending = postJmap('https://x', 'k', [['m', {}, 'c']], {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining(`${DEFAULT_JMAP_TIMEOUT_MS / 1000}s`),
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_JMAP_TIMEOUT_MS);
    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it('requireResponse：JMAP error 响应抛结构化错误且含 description', () => {
    expect(() =>
      requireResponse(
        { methodResponses: [['error', { type: 'unsupportedFilter', description: 'domainId' }, 'd']] },
        'd',
      ),
    ).toThrow('domainId');
    expect(() =>
      requireResponse(
        { methodResponses: [['error', { type: 'unsupportedFilter', description: 'domainId' }, 'd']] },
        'd',
      ),
    ).toThrow(expect.objectContaining({ code: 'UPSTREAM_FAILURE' }));
  });

  it('requireSetSuccess：alreadyExists → ACCOUNT_EXISTS（B1）；密码策略 → PASSWORD_REJECTED；created 原样返回', () => {
    // 真机重复建号走 notCreated.alreadyExists：必须是结构化 code，invites 才能按 409 可恢复冲突处理
    expect(() =>
      requireSetSuccess(
        { notCreated: { new1: { type: 'alreadyExists', description: '账号已存在' } } },
        'createAccount',
        'new1',
      ),
    ).toThrow(expect.objectContaining({ code: 'ACCOUNT_EXISTS' }));
    // 0.16.20 真机实测（2026-09-15 抓包，#189 复测）：同名建号冲突实际形状是
    // type='primaryKeyViolation'、properties=['email']（非 alreadyExists），同样必须归 ACCOUNT_EXISTS（#190 B7 判定依赖）
    expect(() =>
      requireSetSuccess(
        {
          notCreated: {
            n1: {
              type: 'primaryKeyViolation',
              properties: ['email'],
              objectId: { object: 'Account', id: 'y' },
            },
          },
        },
        'x:Account/set',
        'n1',
      ),
    ).toThrow(expect.objectContaining({ code: 'ACCOUNT_EXISTS' }));
    expect(() =>
      requireSetSuccess(
        {
          notUpdated: {
            acc9: {
              type: 'invalidPatch',
              description: 'Password is too weak. Repeats like "abcabcabc" are only slightly harder.',
            },
          },
        },
        'resetPassword',
        'acc9',
      ),
    ).toThrow(expect.objectContaining({ code: 'PASSWORD_REJECTED' }));
    expect(requireSetSuccess({ created: { new1: { id: 'acc1' } } }, 'createAccount', 'new1')).toEqual({
      id: 'acc1',
    });
  });
});

describe('createStalwartMailProvisioner（四方法行为，fetch mock）', () => {
  it('createAccount happy path：x:Domain/query 拿 domainId → x:Account/set create（随机密码 + description）→ 返回 email', async () => {
    // 回显照真实 0.16.17：created.new1 = { id: 'd' }
    const { bodies } = stubFetch([
      ['x:Domain/query', { ids: ['dm1'] }, 'd'],
      ['x:Account/set', { created: { new1: { id: 'd' } } }, 'c'],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(
      provisioner.createAccount({ emailPrefix: 'wang', displayName: '小王' }),
    ).resolves.toEqual({ email: EMAIL });

    expect(bodies.length).toBe(2);
    expect(bodies[0]).toMatchObject({ methodCalls: [['x:Domain/query', { filter: { name: 'example.com' } }, 'd']] });
    const create = (bodies[1] as { methodCalls: Array<[string, { create: Record<string, Record<string, unknown>> }]> })
      .methodCalls[0]![1].create['new1']!;
    // 行为验证：载荷与 0.16.20 实测可用形状逐字段一致（键 '1' 纯数字在索引 List 下幸存）——
    // credentials 键控对象（数组被拒 invalidPatch），aliases/memberGroupIds 传 {}（数组被拒 Invalid value for aliases）
    expect(create).toEqual({
      '@type': 'User',
      name: 'wang',
      domainId: 'dm1',
      credentials: { '1': { '@type': 'Password', secret: expect.any(String) } },
      roles: { '@type': 'User' },
      permissions: { '@type': 'Inherit' },
      // B4：displayName 写 Stalwart User.description，与假实现存的 displayName 语义一致
      description: '小王',
      aliases: {},
      memberGroupIds: {},
      quotas: {},
      encryptionAtRest: { '@type': 'Disabled' },
    });
    expect((create['credentials'] as { '1': { secret: string } })['1']!.secret).toHaveLength(24);
  });

  it('createAccount：域名不存在 → 人话错误，不建号', async () => {
    const { bodies, fetchFn } = stubFetch([['x:Domain/query', { ids: [] }, 'd']]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(
      provisioner.createAccount({ emailPrefix: 'wang', displayName: '小王' }),
    ).rejects.toThrow('Stalwart 中没有域名 example.com');
    expect(bodies.length).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('createAccount：服务端拒绝（alreadyExists）→ 结构化 ACCOUNT_EXISTS（人话保留）', async () => {
    stubFetch([
      ['x:Domain/query', { ids: ['dm1'] }, 'd'],
      [
        'x:Account/set',
        { notCreated: { new1: { type: 'alreadyExists', description: '账号已存在' } } },
        'c',
      ],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(
      provisioner.createAccount({ emailPrefix: 'wang', displayName: '小王' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS', message: expect.stringContaining('账号已存在') });
  });

  it('disableAccount（Inherit 账号）：读回 Inherit → 写 Merge + disabled.authenticate（沿用实测可用形状）', async () => {
    const { bodies, fetchFn } = stubFetch([
      ...accountReadResponses({ '@type': 'Inherit' }),
      ['x:Account/set', { updated: { [ACCOUNT_ID]: null } }, 'u'],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(provisioner.disableAccount({ email: EMAIL })).resolves.toBeUndefined();

    expect(bodies.length).toBe(2); // query+get 合成一个请求，update 单独一个
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const queryGet = bodies[0] as { methodCalls: Array<[string, Record<string, unknown>]> };
    const update = bodies[1] as { methodCalls: Array<[string, Record<string, unknown>]> };
    // 读-改-写第一步：JMAP 结果引用把 query 的 ids 传给 Account/get（一次请求拿 id + permissions）
    expect(queryGet.methodCalls).toEqual([
      ['x:Account/query', { filter: { name: 'wang' } }, 'q'],
      ['x:Account/get', { '#ids': { resultOf: 'q', name: 'x:Account/query', path: '/ids' } }, 'g'],
    ]);
    const patch = sentUpdate(update)['permissions'] as Record<string, unknown>;
    // 0.16.20 定案形状（issue #148）：PermissionsList 的 enabled/disabledPermissions 是
    // Map<Permission>（对象 + bool），不是数组。实测：数组形状 invalidPatch
    // 「Invalid value for object property (permissions/enabledPermissions)」；Merge+map → updated
    // 且登录 403。同形于上游 crates/scim/src/users/mod.rs set_active 的禁用形状。
    expect(patch).toEqual({
      '@type': 'Merge',
      enabledPermissions: {},
      disabledPermissions: { authenticate: true },
    });
    expect(Array.isArray(patch['disabledPermissions'])).toBe(false); // 防回潮：不得是数组
  });

  it.each(['Merge', 'Replace'] as const)(
    'disableAccount→enableAccount（%s 显式权限）：只改 authenticate 位，其余显式权限往返无失',
    async (mode) => {
      // 真机实测（issue #189）：旧实现整表覆盖 → enable 后回 Inherit、显式位全丢。
      // 这里让假服务器按真机行为【整值覆写】permissions，往返后其余显式权限必须一个不少。
      const initial = {
        '@type': mode,
        enabledPermissions: { jmapEmailSend: true },
        disabledPermissions: { imapGet: true },
      };
      const server = permissionsServer(initial);
      const provisioner = createStalwartMailProvisioner(config);

      await provisioner.disableAccount({ email: EMAIL });
      expect(server.read()).toEqual({
        '@type': mode,
        enabledPermissions: { jmapEmailSend: true },
        disabledPermissions: { imapGet: true, authenticate: true },
      });

      await provisioner.enableAccount({ email: EMAIL });
      // Merge：摘掉 disabled 位即恢复；Replace：角色集被忽略，激活必须显式授 authenticate
      // （上游 set_active 的 replace_grants_authenticate_on_activation 同口径）
      expect(server.read()).toEqual({
        '@type': mode,
        enabledPermissions:
          mode === 'Replace'
            ? { jmapEmailSend: true, authenticate: true }
            : { jmapEmailSend: true },
        disabledPermissions: { imapGet: true },
      });
    },
  );

  it('disableAccount→enableAccount（Inherit 账号）：回读仍是 Inherit（验收口径）', async () => {
    const server = permissionsServer({ '@type': 'Inherit' });
    const provisioner = createStalwartMailProvisioner(config);

    await provisioner.disableAccount({ email: EMAIL });
    expect(server.read()).toEqual({
      '@type': 'Merge',
      enabledPermissions: {},
      disabledPermissions: { authenticate: true },
    });

    await provisioner.enableAccount({ email: EMAIL });
    expect(server.read()).toEqual({ '@type': 'Inherit' });
  });

  it.each(['Merge', 'Replace'] as const)(
    'disableAccount→enableAccount：原 enabled 里就有 authenticate:true 的账号（%s），往返后显式位仍在（acceptance #2）',
    async (mode) => {
      // issue #189 真机实测的那个账号形状：permissions = Merge{enabled:{authenticate:true}}
      const initial = {
        '@type': mode,
        enabledPermissions: { authenticate: true },
        disabledPermissions: {},
      };
      const server = permissionsServer(initial);
      const provisioner = createStalwartMailProvisioner(config);

      await provisioner.disableAccount({ email: EMAIL });
      // disabled 恒优先（上游 finalize = enabled - disabled）：authenticate 在册即禁用，
      // 同时原 enabled 表一个键都不动 —— enable 才有得可还原。
      expect(server.read()).toEqual({
        '@type': mode,
        enabledPermissions: { authenticate: true },
        disabledPermissions: { authenticate: true },
      });

      await provisioner.enableAccount({ email: EMAIL });
      expect(server.read()).toEqual(initial);
    },
  );

  it('enableAccount：disabled 表里 authenticate 在册（即使值为 false）也算禁用位，摘完回 Inherit', async () => {
    // 上游 PermissionsList 只看键（as_slice()），不看布尔值——所以在册即禁用，摘掉即恢复
    const server = permissionsServer({
      '@type': 'Merge',
      enabledPermissions: {},
      disabledPermissions: { authenticate: false },
    });
    const provisioner = createStalwartMailProvisioner(config);
    await provisioner.enableAccount({ email: EMAIL });
    expect(server.read()).toEqual({ '@type': 'Inherit' });
  });

  it('disableAccount：permissions 形状不可识别 → 结构化报错且不发 update（宁可不改也不覆盖）', async () => {
    const server = permissionsServer({ '@type': 'SomeFutureMode', enabledPermissions: {} });
    const provisioner = createStalwartMailProvisioner(config);

    await expect(provisioner.disableAccount({ email: EMAIL })).rejects.toMatchObject({
      code: 'UPSTREAM_FAILURE',
      message: expect.stringContaining('permissions 形状无法识别'),
    });
    expect(server.patches).toEqual([]);
  });

  it('parsePermissions：缺省/缺字段按 Inherit；非布尔值不猜', () => {
    expect(parsePermissions(undefined)).toEqual({ '@type': 'Inherit' });
    expect(
      parsePermissions({ '@type': 'Merge', enabledPermissions: { authenticate: true } }),
    ).toEqual({
      '@type': 'Merge',
      enabledPermissions: { authenticate: true },
      disabledPermissions: {},
    });
    expect(() => parsePermissions({ '@type': 'Merge', enabledPermissions: [] })).toThrow(
      'permissions.enabledPermissions 不是对象',
    );
  });

  // 0.16.20 定案形状（issue #148）：credentials 属性是索引 List，patch 的 map 键必须是数字
  // 索引（实测：随机/字母键 invalidPatch「Invalid key for object property」，数字键 "0" → updated，
  // 旧密码 401 / 新密码 200）。0.16.17 的随机新键形状（issue #113）升 0.16.20 后失效。
  it('resetPassword：credentials 数字索引键 "0"（替换旧凭据）', async () => {
    const { bodies } = stubFetch([
      ...accountReadResponses({ '@type': 'Inherit' }),
      ['x:Account/set', { updated: { [ACCOUNT_ID]: null } }, 'u'],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(
      provisioner.resetPassword({ email: EMAIL, password: '新密码abc' }),
    ).resolves.toBeUndefined();
    const update = bodies[1] as { methodCalls: Array<[string, Record<string, unknown>]> };
    const patch = sentUpdate(update);
    expect(Object.keys(patch)).toEqual(['credentials']);
    const credentials = patch['credentials'] as Record<string, { '@type': string; secret: string }>;
    const keys = Object.keys(credentials);
    expect(keys).toEqual(['0']); // 数字索引，服务端 parse::<u32>() 可接受；字母键被拒 invalidPatch
    expect(credentials['0']).toEqual({ '@type': 'Password', secret: '新密码abc' });
  });

  // 0.16.17：query 精确匹配 0 命中 → 不再发 x:Account/get，直接 ACCOUNT_NOT_FOUND
  it('查无此人（query 精确匹配 0 命中）→ ACCOUNT_NOT_FOUND，不发 set', async () => {
    const { bodies, fetchFn } = stubFetch([['x:Account/query', { ids: [] }, 'q']]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(provisioner.disableAccount({ email: 'ghost@example.com' })).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    await expect(provisioner.resetPassword({ email: 'ghost@example.com', password: 'x' })).rejects.toBeInstanceOf(
      MailProvisionerError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2); // 每次仅一个 query+get 请求，无 set
    expect(JSON.stringify(bodies)).not.toContain('x:Account/set');
  });

  it('HTTP 401 → 结构化 AUTH_FAILED + httpStatus=401（凭证无效）', async () => {
    stubFetch([], 401);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(provisioner.enableAccount({ email: EMAIL })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      httpStatus: 401,
    });
  });

  it('四方法超时（B5）：服务器不响应时 10s 内抛 TIMEOUT，不挂死', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {})); // 永不响应
    vi.stubGlobal('fetch', fetchFn);
    const provisioner = createStalwartMailProvisioner(config);

    const cases: Array<() => Promise<unknown>> = [
      () => provisioner.createAccount({ emailPrefix: 'wang', displayName: '小王' }),
      () => provisioner.disableAccount({ email: EMAIL }),
      () => provisioner.enableAccount({ email: EMAIL }),
      () => provisioner.resetPassword({ email: EMAIL, password: '新密码abc' }),
    ];
    for (const call of cases) {
      const rejection = expect(call()).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(DEFAULT_JMAP_TIMEOUT_MS);
      await rejection;
    }
  });

  it('超时可配置：timeoutMs 生效（不写死 10s）', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchFn);
    const provisioner = createStalwartMailProvisioner({ ...config, timeoutMs: 50 });

    const pending = provisioner.enableAccount({ email: EMAIL });
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('0.1s'),
    });
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });
});

describe('createFakeMailProvisioner（假实现语义）', () => {
  it('四方法走通并记录 calls', async () => {
    const fake = createFakeMailProvisioner();
    const { email } = await fake.createAccount({ emailPrefix: 'li', displayName: '小李' });
    expect(email).toBe('li@example.com');
    await fake.disableAccount({ email });
    await fake.enableAccount({ email });
    await fake.resetPassword({ email, password: 'pw2' });
    expect(fake.calls.map((call) => call.method)).toEqual([
      'createAccount',
      'disableAccount',
      'enableAccount',
      'resetPassword',
    ]);
    // B4 真假一致：displayName 在假实现里真落内存（真实现落 Stalwart description）
    expect(fake.accounts.get(email)).toMatchObject({ displayName: '小李', disabled: false, password: 'pw2' });
  });

  it('重复 create 抛 ACCOUNT_EXISTS；查无此人抛 ACCOUNT_NOT_FOUND', async () => {
    const fake = createFakeMailProvisioner();
    await fake.createAccount({ emailPrefix: 'li', displayName: '小李' });
    await expect(fake.createAccount({ emailPrefix: 'li', displayName: '又一个小李' })).rejects.toMatchObject({
      code: 'ACCOUNT_EXISTS',
    });
    await expect(fake.enableAccount({ email: 'ghost@example.com' })).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
  });
});
