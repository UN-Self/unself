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
    const { bodies } = stubFetch([
      ['x:Domain/query', { ids: ['dm1'] }, 'd'],
      ['x:Account/set', { created: { new1: { id: 'acc1' } } }, 'c'],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(
      provisioner.createAccount({ emailPrefix: 'wang', displayName: '小王' }),
    ).resolves.toEqual({ email: 'wang@example.com' });

    expect(bodies.length).toBe(2);
    expect(bodies[0]).toMatchObject({ methodCalls: [['x:Domain/query', { filter: { name: 'example.com' } }, 'd']] });
    const create = (bodies[1] as { methodCalls: Array<[string, { create: Record<string, Record<string, unknown>> }]> })
      .methodCalls[0]![1].create['new1']!;
    expect(create).toMatchObject({
      '@type': 'User',
      name: 'wang',
      domainId: 'dm1',
      roles: { '@type': 'User' },
    });
    const secret = (create['credentials'] as Array<{ secret: string }>)[0]!.secret;
    expect(secret).toHaveLength(24);
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
    const { bodies } = stubFetch([
      ['x:Account/query', { ids: ['acc9'] }, 'q'],
      ['x:Account/get', { list: [{ id: 'acc9', emails: ['wang@example.com'] }] }, 'g'],
      ['x:Account/set', { updated: { acc9: null } }, 'u'],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(provisioner.disableAccount({ email: 'wang@example.com' })).resolves.toBeUndefined();

    expect(bodies.length).toBe(2); // query+get 在同一请求（#ids 引用），update 单独一个
    const queryGet = bodies[0] as { methodCalls: Array<[string, Record<string, unknown>]> };
    const update = bodies[1] as { methodCalls: Array<[string, Record<string, unknown>]> };
    expect(queryGet.methodCalls[0]![0]).toBe('x:Account/query');
    expect(queryGet.methodCalls[0]![1]).toMatchObject({ filter: { name: 'wang' } });
    expect(queryGet.methodCalls[1]![0]).toBe('x:Account/get');
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
      ['x:Account/get', { list: [{ id: 'acc9', emails: ['wang@example.com'] }] }, 'g'],
      ['x:Account/set', { updated: { acc9: null } }, 'u'],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(provisioner.enableAccount({ email: 'wang@example.com' })).resolves.toBeUndefined();
    const update = bodies[1] as { methodCalls: Array<[string, Record<string, unknown>]> };
    const setArgs = update.methodCalls[0]![1] as { update: Record<string, Record<string, unknown>> };
    expect(setArgs.update['acc9']).toEqual({ permissions: { '@type': 'Inherit' } });
  });

  it('resetPassword：update credentials 为新密码', async () => {
    const { bodies } = stubFetch([
      ['x:Account/query', { ids: ['acc9'] }, 'q'],
      ['x:Account/get', { list: [{ id: 'acc9', emails: ['wang@example.com'] }] }, 'g'],
      ['x:Account/set', { updated: { acc9: null } }, 'u'],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(
      provisioner.resetPassword({ email: 'wang@example.com', password: '新密码abc' }),
    ).resolves.toBeUndefined();
    const update = bodies[1] as { methodCalls: Array<[string, Record<string, unknown>]> };
    const setArgs = update.methodCalls[0]![1] as { update: Record<string, Record<string, unknown>> };
    expect(setArgs.update['acc9']).toEqual({ credentials: [{ '@type': 'Password', secret: '新密码abc' }] });
  });

  it('查无此人 → ACCOUNT_NOT_FOUND', async () => {
    stubFetch([
      ['x:Account/query', { ids: [] }, 'q'],
      ['x:Account/get', { list: [] }, 'g'],
    ]);
    const provisioner = createStalwartMailProvisioner(config);
    await expect(provisioner.disableAccount({ email: 'ghost@example.com' })).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    await expect(provisioner.resetPassword({ email: 'ghost@example.com', password: 'x' })).rejects.toBeInstanceOf(
      MailProvisionerError,
    );
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
