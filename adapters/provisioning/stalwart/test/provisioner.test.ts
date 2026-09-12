// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postJmap, requireResponse, requireSetSuccess } from '../src/jmap.ts';
import {
  MailProvisionerError,
  createStalwartMailProvisioner,
  type StalwartProvisionerConfig,
} from '../src/stalwart-provisioner.ts';
import { createFakeMailProvisioner } from '../src/fake.ts';
import type { JmapMethodResponse } from '../src/jmap.ts';

const config: StalwartProvisionerConfig = {
  baseUrl: 'https://mail.example.com',
  apiKey: 'sk-1',
  domain: 'example.com',
};

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

afterEach(() => {
  vi.unstubAllGlobals();
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
      fetchFn,
    );
    expect(result.methodResponses).toEqual([['x:Domain/query', { ids: ['dm1'] }, 'd']]);
  });

  it('凭证缺失：抛「Stalwart API key 未配置」，不发请求', async () => {
    const fetchFn = vi.fn();
    await expect(
      postJmap('https://x', undefined, [['m', {}, 'c']], fetchFn as typeof fetch),
    ).rejects.toThrow('Stalwart API key 未配置');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('非 2xx：抛错含 HTTP 状态', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(postJmap('https://x', 'k', [['m', {}, 'c']], fetchFn)).rejects.toThrow('HTTP 403');
  });

  it('网络失败：抛人话错误', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(postJmap('https://x', 'k', [['m', {}, 'c']], fetchFn)).rejects.toThrow('网络错误');
  });

  it('响应缺 methodResponses：抛人话错误', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(postJmap('https://x', 'k', [['m', {}, 'c']], fetchFn)).rejects.toThrow(
      'methodResponses',
    );
  });

  it('requireResponse：JMAP error 响应抛含 description 的人话错误', async () => {
    expect(() =>
      requireResponse(
        { methodResponses: [['error', { type: 'unsupportedFilter', description: 'domainId' }, 'd']] },
        'd',
      ),
    ).toThrow('domainId');
  });

  it('requireSetSuccess：notCreated SetError 抛含 description 的人话错误；created 原样返回', () => {
    expect(() =>
      requireSetSuccess(
        { notCreated: { new1: { type: 'alreadyExists', description: '邮箱已存在' } } },
        'createAccount',
        'new1',
      ),
    ).toThrow('邮箱已存在');
    expect(requireSetSuccess({ created: { new1: { id: 'acc1' } } }, 'createAccount', 'new1')).toEqual({
      id: 'acc1',
    });
  });
});

describe('createStalwartMailProvisioner（四方法行为，fetch mock）', () => {
  it('createAccount happy path：x:Domain/query 拿 domainId → x:Account/set create（随机密码）→ 返回 email', async () => {
    // 回显照真实 0.16.17：created.new1 = { id: 'd' }
    const { bodies } = stubFetch([
      ['x:Domain/query', { ids: ['dm1'] }, 'd'],
      ['x:Account/set', { created: { new1: { id: 'd' } } }, 'c'],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(
      provisioner.createAccount({ emailPrefix: 'wang', displayName: '小王' }),
    ).resolves.toEqual({ email: 'wang@example.com' });

    expect(bodies.length).toBe(2);
    expect(bodies[0]).toMatchObject({ methodCalls: [['x:Domain/query', { filter: { name: 'example.com' } }, 'd']] });
    const create = (bodies[1] as { methodCalls: Array<[string, { create: Record<string, Record<string, unknown>> }]> })
      .methodCalls[0]![1].create['new1']!;
    // 行为验证：载荷与 0.16.17 实测可用形状逐字段一致——credentials 键控对象（数组被拒
    // invalidPatch），aliases/memberGroupIds 传 {}（数组被拒 Invalid value for aliases）
    expect(create).toEqual({
      '@type': 'User',
      name: 'wang',
      domainId: 'dm1',
      credentials: { '1': { '@type': 'Password', secret: expect.any(String) } },
      roles: { '@type': 'User' },
      permissions: { '@type': 'Inherit' },
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

  it('createAccount：服务端拒绝（alreadyExists）→ 人话错误', async () => {
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
    ).rejects.toThrow('账号已存在');
  });

  it('disableAccount：按 email 查到账户 → update 摘 authenticate 权限位', async () => {
    // 0.16.17：query 的 name 过滤精确匹配，命中即用——不再发 x:Account/get（账号对象无 emails 字段）
    const { bodies, fetchFn } = stubFetch([
      ['x:Account/query', { ids: ['acc9'] }, 'q'],
      ['x:Account/set', { updated: { acc9: null } }, 'u'],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(provisioner.disableAccount({ email: 'wang@example.com' })).resolves.toBeUndefined();

    expect(bodies.length).toBe(2); // query 一个请求，update 单独一个
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const queryGet = bodies[0] as { methodCalls: Array<[string, Record<string, unknown>]> };
    const update = bodies[1] as { methodCalls: Array<[string, Record<string, unknown>]> };
    expect(queryGet.methodCalls).toEqual([['x:Account/query', { filter: { name: 'wang' } }, 'q']]);
    const setArgs = update.methodCalls[0]![1] as { update: Record<string, Record<string, unknown>> };
    const patch = setArgs.update['acc9']!;
    expect(patch).toEqual({
      permissions: {
        '@type': 'Replace',
        enabledPermissions: [],
        disabledPermissions: ['authenticate'],
      },
    });
  });

  it('enableAccount：update 恢复 Inherit', async () => {
    const { bodies } = stubFetch([
      ['x:Account/query', { ids: ['acc9'] }, 'q'],
      ['x:Account/set', { updated: { acc9: null } }, 'u'],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(provisioner.enableAccount({ email: 'wang@example.com' })).resolves.toBeUndefined();
    const update = bodies[1] as { methodCalls: Array<[string, Record<string, unknown>]> };
    const setArgs = update.methodCalls[0]![1] as { update: Record<string, Record<string, unknown>> };
    expect(setArgs.update['acc9']).toEqual({ permissions: { '@type': 'Inherit' } });
  });

  // 0.16.17 定案形状（issue #113）：update.credentials 用「随机新键 → Password」键控对象；
  // 服务端按同 type 单凭据语义替换——凭据列表回到单条、credentialId 变更、旧密码 401。
  it('resetPassword：credentials 随机新键键控对象（替换旧凭据）', async () => {
    const { bodies } = stubFetch([
      ['x:Account/query', { ids: ['acc9'] }, 'q'],
      ['x:Account/set', { updated: { acc9: null } }, 'u'],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(
      provisioner.resetPassword({ email: 'wang@example.com', password: '新密码abc' }),
    ).resolves.toBeUndefined();
    const update = bodies[1] as { methodCalls: Array<[string, Record<string, unknown>]> };
    const setArgs = update.methodCalls[0]![1] as { update: Record<string, Record<string, unknown>> };
    const patch = setArgs.update['acc9']!;
    expect(Object.keys(patch)).toEqual(['credentials']);
    const credentials = patch['credentials'] as Record<string, { '@type': string; secret: string }>;
    const keys = Object.keys(credentials);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe('1'); // 每次 reset 随机新键，不与建号键 '1' 撞
    expect(credentials[keys[0]!]).toEqual({ '@type': 'Password', secret: '新密码abc' });
  });

  // 0.16.17：query 精确匹配 0 命中 → 不再发 x:Account/get，直接 ACCOUNT_NOT_FOUND
  it('查无此人（query 精确匹配 0 命中）→ ACCOUNT_NOT_FOUND，不发 x:Account/get', async () => {
    const { fetchFn } = stubFetch([['x:Account/query', { ids: [] }, 'q']]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(provisioner.disableAccount({ email: 'ghost@example.com' })).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    await expect(provisioner.resetPassword({ email: 'ghost@example.com', password: 'x' })).rejects.toBeInstanceOf(
      MailProvisionerError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2); // 每次仅一个 query 请求
  });

  it('HTTP 401 → 抛错含状态（凭证无效）', async () => {
    stubFetch([], 401);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(provisioner.enableAccount({ email: 'wang@example.com' })).rejects.toThrow('HTTP 401');
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
