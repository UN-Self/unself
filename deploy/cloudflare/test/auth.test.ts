// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 凭证解析行为测试（#246 / 决策 #66）：全部注入（execFile/env 替身），不碰真实 wrangler。
 * 红灯点：
 * - 「OAuth 不可用时不回落、给明确指引」——把 null 返回改成空 token 或静默换路必红；
 * - 优先级顺序改坏（OAuth 抢在 env token 前 / Global Key 静默滑到 OAuth）必红；
 * - 版本警告（≠4.129.0）丢失必红。
 */
import { describe, expect, it } from 'vitest';
import {
  CredentialsMissingError,
  credentialsMissingMessage,
  resolveAuth,
  type ExecFileLike,
  type TokenSource,
} from '../src/auth';
import { findWranglerBin, parseWranglerTokenOutput } from '../src/rest/token';

/** 93 字符实测形状的 OAuth token（docs/audit/241-*：cfoat_ 前缀 + base64url）。 */
const OAUTH_TOKEN = `cfoat_${'a'.repeat(86)}`;

/** wrangler auth token 实测输出形状（装饰行 + token + 尾注）。 */
const okAuthToken = (extra = ''): { stdout: string; stderr: string } => ({
  stdout: ` ⛅️ wrangler 4.129.0\n-------------------\n${OAUTH_TOKEN}${extra}\n`,
  stderr: '',
});

describe('resolveAuth 优先级（同官方：env token > API key/email > OAuth）', () => {
  it('env token 第一优先：即使 wrangler 可用也零 spawn（红灯点：优先级颠倒必红）', async () => {
    const calls: string[] = [];
    const execFile: ExecFileLike = async (cmd) => {
      calls.push(cmd);
      return okAuthToken();
    };
    const cred = await resolveAuth({
      env: { CLOUDFLARE_API_TOKEN: 'env-tok' },
      wranglerBin: 'wrangler',
      execFile,
    });
    expect(cred).toEqual({ token: 'env-tok', source: 'env-api-token', note: 'CLOUDFLARE_API_TOKEN（环境变量）' });
    expect(calls).toEqual([]);
  });

  it('Global Key（API key/email）次优先：显式拒绝（装配客户端只认 Bearer），绝不静默滑到 OAuth（红灯点必红）', async () => {
    const calls: string[] = [];
    const execFile: ExecFileLike = async (cmd) => {
      calls.push(cmd);
      return okAuthToken();
    };
    await expect(
      resolveAuth({ env: { CLOUDFLARE_API_KEY: 'gk', CLOUDFLARE_EMAIL: 'a@b.c' }, wranglerBin: 'wrangler', execFile }),
    ).rejects.toThrow(/API Token/);
    expect(calls).toEqual([]); // 不许拿 OAuth 顶包
  });

  it('只给 email 不给 key（半配置）→ 同样显式报错，不滑到 OAuth', async () => {
    await expect(
      resolveAuth({ env: { CLOUDFLARE_EMAIL: 'a@b.c' }, wranglerBin: '', execFile: async () => okAuthToken() }),
    ).rejects.toThrow(/CLOUDFLARE_API_KEY|API Token/);
  });
});

describe('OAuth 借用（wrangler auth token）', () => {
  it('借用成功：spawn 注入 + 输出剥装饰 + 默认探测版本（4.129.0 = 已验证 → 无警告）', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const execFile: ExecFileLike = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === 'auth') return okAuthToken();
      return { stdout: '4.129.0\n', stderr: '' };
    };
    const cred = (await resolveAuth({ env: {}, wranglerBin: 'wrangler', execFile })) as TokenSource;
    expect(cred.source).toBe('wrangler-oauth');
    expect(cred.token).toBe(OAUTH_TOKEN);
    expect(cred.warning).toBeUndefined();
    expect(calls.map((c) => c.args[0])).toEqual(['auth', '--version']);
    expect(calls[0]!.args[1]).toBe('token');
    expect(calls[0]!.args[2]).toBeUndefined(); // `wrangler auth token` 无额外参数
  });

  it('版本 ≠ 已验证（4.129.1）→ warning 指名两版本（红灯点：警告丢失必红）', async () => {
    const execFile: ExecFileLike = async (_cmd, args) =>
      args[0] === 'auth' ? okAuthToken() : { stdout: '4.129.1\n', stderr: '' };
    const cred = (await resolveAuth({ env: {}, wranglerBin: 'wrangler', execFile })) as TokenSource;
    expect(cred.warning).toContain('4.129.1');
    expect(cred.warning).toContain('4.129.0');
  });

  it('探测关闭（probe:false）→ 不发 --version、无警告', async () => {
    const calls: string[] = [];
    const execFile: ExecFileLike = async (_cmd, args) => {
      calls.push(args[0]!);
      return okAuthToken();
    };
    const cred = (await resolveAuth({ env: {}, wranglerBin: 'wrangler', execFile, probe: false })) as TokenSource;
    expect(cred.warning).toBeUndefined();
    expect(calls).toEqual(['auth']);
  });

  it('未登录（无 token 输出）→ null + 人话（wrangler login 指引），不回落不崩（红灯点：静默空 token 必红）', async () => {
    const logs: string[] = [];
    const execFile: ExecFileLike = async () => ({ stdout: ' ⛅️ wrangler 4.129.0\nnot logged in\n', stderr: '' });
    const cred = await resolveAuth({ env: {}, wranglerBin: 'wrangler', execFile, log: (m) => logs.push(m) });
    expect(cred).toBeNull();
    expect(logs.join('\n')).toContain('wrangler login');
  });

  it('spawn 失败（无 wrangler：ENOENT）→ null + API Token 路径指引，零额外下载（红灯点：抛裸栈或回落必红）', async () => {
    const logs: string[] = [];
    const execFile: ExecFileLike = async () => {
      throw new Error("spawn wrangler ENOENT: no such file or directory");
    };
    const cred = await resolveAuth({ env: {}, wranglerBin: 'wrangler', execFile, log: (m) => logs.push(m) });
    expect(cred).toBeNull();
    expect(logs.join('\n')).toContain('ENOENT');
    expect(logs.join('\n')).toContain('API Token');
  });

  it('wranglerBin 空串 = 显式跳过 OAuth（无 wrangler 机器的注入替身）：零 spawn 直接 null', async () => {
    const calls: string[] = [];
    const execFile: ExecFileLike = async (cmd) => {
      calls.push(cmd);
      return okAuthToken();
    };
    const cred = await resolveAuth({ env: {}, wranglerBin: '', execFile });
    expect(cred).toBeNull();
    expect(calls).toEqual([]);
  });

  it('配置目录透传：WRANGLER_CONFIG_DIR 进子进程 env（wrangler 自行解析；keyring 加密同走该命令）', async () => {
    let seen: unknown;
    const execFile: ExecFileLike = async (_cmd, _args, opts) => {
      seen = opts?.env;
      return okAuthToken();
    };
    await resolveAuth({
      env: { WRANGLER_CONFIG_DIR: '/custom/cfg', XDG_CONFIG_HOME: '/xdg' },
      wranglerBin: 'wrangler',
      execFile,
      probe: false,
    });
    expect((seen as { WRANGLER_CONFIG_DIR?: string }).WRANGLER_CONFIG_DIR).toBe('/custom/cfg');
    expect((seen as { XDG_CONFIG_HOME?: string }).XDG_CONFIG_HOME).toBe('/xdg');
  });
});

describe('缺凭证（两条路全断）', () => {
  it('CredentialsMissingError + credentialsMissingMessage：给 API Token 深链接与 wrangler login 两条路', () => {
    expect(credentialsMissingMessage()).toContain('wrangler login');
    expect(credentialsMissingMessage()).toContain('api-tokens');
    const e = new CredentialsMissingError();
    expect(e.name).toBe('CredentialsMissingError');
    expect(e.message).toContain('API Token');
  });

  it('findWranglerBin：UNSELF_WRANGLER_BIN 显式指定优先（注入点，测试/CI 用）', () => {
    expect(findWranglerBin({ UNSELF_WRANGLER_BIN: '/custom/bin/wrangler' })).toBe('/custom/bin/wrangler');
  });
});

describe('parseWranglerTokenOutput（wrangler 输出剥装饰）', () => {
  it('最长命中 = token 本体（实测 4.129.x 输出形状）', () => {
    const out = '⛅ wrangler 4.129.0\n-------------------\neyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcd1234567890abcd1234567890abcd1234567890 说明文字';
    expect(parseWranglerTokenOutput(out)).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcd1234567890abcd1234567890abcd1234567890');
  });
  it('无长 token → null（未登录等）', () => {
    expect(parseWranglerTokenOutput('You are not authenticated. Please run `wrangler login`.')).toBeNull();
  });
});
