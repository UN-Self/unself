// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ExecFileSyncOptions } from 'node:child_process';
import {
  buildTokenDeepLink,
  buildTokenFirstScreen,
  chooseDomain,
  collectToken,
  createAsker,
  domainProblem,
  echoControl,
  sttyRef,
  askSecret,
  parseCliArgs,
  parseModulesInput,
  pickTokenDecision,
  resolveDomainChoice,
  tokenProblem,
  UnknownFlagError,
  usageText,
  TOKEN_PERMISSION_TABLE,
} from '../src/interactive';

describe('parseCliArgs（CLI 参数解析）', () => {
  it('全缺省：无参数 → 仅 yes:false', () => {
    expect(parseCliArgs([])).toEqual({ yes: false });
  });
  it('--domain=<d> 解析域名', () => {
    expect(parseCliArgs(['--domain=team.example.com'])).toEqual({ domain: 'team.example.com', yes: false });
  });
  it('--modules=<a,b> 逗号分隔；空串 → []', () => {
    expect(parseCliArgs(['--modules=hello,meet'])).toEqual({ modules: ['hello', 'meet'], yes: false });
    expect(parseCliArgs(['--modules='])).toEqual({ modules: [], yes: false });
  });
  it('-y 与 --yes 都开静默', () => {
    expect(parseCliArgs(['-y']).yes).toBe(true);
    expect(parseCliArgs(['--yes']).yes).toBe(true);
  });
  it('重复参数后者胜', () => {
    expect(parseCliArgs(['--domain=a.example', '--domain=b.example']).domain).toBe('b.example');
    expect(parseCliArgs(['--modules=a', '--modules=a,b']).modules).toEqual(['a', 'b']);
  });
  it('未知参数报错（#249 行为变更：静默忽略会把拼错的配置吞掉）', () => {
    expect(() => parseCliArgs(['--domian=x'])).toThrow(UnknownFlagError);
    // did-you-mean：编辑距离 ≤2 → 建议最接近的已知参数
    expect(() => parseCliArgs(['--domian=x'])).toThrow(/--domain/);
    expect(() => parseCliArgs(['--modulles=a'])).toThrow(/--modules/);
    // 判不出接近谁 → 仅报未知，指去 --help
    let msg = '';
    try {
      parseCliArgs(['--zzzzzzzz']);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('未知参数');
    expect(msg).toContain('--help');
    expect(msg).not.toContain('最接近');
  });
  it('--domain / --modules 缺等号 → 指路取值写法', () => {
    expect(() => parseCliArgs(['--domain'])).toThrow(/等号/);
    expect(() => parseCliArgs(['--modules'])).toThrow(/等号/);
  });
  it('--help/-h/--version 进 info 位；与其余参数可共存', () => {
    expect(parseCliArgs(['--help']).info).toBe('help');
    expect(parseCliArgs(['-h']).info).toBe('help');
    expect(parseCliArgs(['--version']).info).toBe('version');
    expect(parseCliArgs(['--domain=a.example', '--help'])).toEqual({ domain: 'a.example', yes: false, info: 'help' });
  });
});

describe('usageText（--help 用法文本）', () => {
  it('版本号、全部参数与「退出不部署」语义都在', () => {
    const text = usageText('9.9.9-test').join('\n');
    expect(text).toContain('9.9.9-test');
    for (const f of ['--domain=', '--modules=', '-y, --yes', '-h, --help', '--version']) {
      expect(text).toContain(f);
    }
    expect(text).toContain('CLOUDFLARE_API_TOKEN');
  });
});

describe('resolveDomainChoice（优先级：CLI > 交互 > 配置文件）', () => {
  const interactive = () => Promise.resolve('asked.example');

  it('CLI 设定 → 直接用 CLI', async () => {
    const r = await resolveDomainChoice({ cli: parseCliArgs(['--domain=cli.example']), configDomain: 'cfg.example', tty: true, interactive });
    expect(r).toEqual({ domain: 'cli.example', source: 'cli' });
  });
  it('配置文件有值 → 用配置，不交互', async () => {
    const r = await resolveDomainChoice({ cli: parseCliArgs([]), configDomain: 'cfg.example', tty: true, interactive });
    expect(r).toEqual({ domain: 'cfg.example', source: 'config' });
  });
  it('都没设且 TTY → 交互', async () => {
    const r = await resolveDomainChoice({ cli: parseCliArgs([]), configDomain: '', tty: true, interactive });
    expect(r).toEqual({ domain: 'asked.example', source: 'interactive' });
  });
  it('都没设且 -y → 静默 workers.dev（null）', async () => {
    const r = await resolveDomainChoice({ cli: parseCliArgs(['-y']), configDomain: '', tty: true, interactive });
    expect(r).toEqual({ domain: null, source: 'config' });
  });
  it('都没设且非 TTY → 静默 workers.dev（CI 安全，不交互）', async () => {
    const r = await resolveDomainChoice({ cli: parseCliArgs([]), configDomain: '', tty: false, interactive });
    expect(r).toEqual({ domain: null, source: 'config' });
  });
  it('配置有值且 -y：仍走配置值', async () => {
    const r = await resolveDomainChoice({ cli: parseCliArgs(['-y']), configDomain: 'cfg.example', tty: false, interactive });
    expect(r).toEqual({ domain: 'cfg.example', source: 'config' });
  });
});

describe('chooseDomain（域名三选交互）', () => {
  function fakeIo(answers: string[]) {
    const out: string[] = [];
    let i = 0;
    return {
      io: {
        ask: (q: string) => {
          out.push(q);
          return Promise.resolve(answers[i++] ?? '');
        },
        out: (line: string) => out.push(line),
      },
      out,
    };
  }

  it('选 1 → workers.dev（null）', async () => {
    const { io } = fakeIo(['1']);
    expect(await chooseDomain(io)).toBeNull();
  });
  it('回车默认 1', async () => {
    const { io } = fakeIo(['']);
    expect(await chooseDomain(io)).toBeNull();
  });
  it('选 2 输入域名 → own domain', async () => {
    const { io } = fakeIo(['2', 'team.example.com']);
    expect(await chooseDomain(io)).toBe('team.example.com');
  });
  it('选 2 空域名重问一次', async () => {
    const { io } = fakeIo(['2', '', ' team.example.com ']);
    expect(await chooseDomain(io)).toBe('team.example.com');
  });
  it('选 2 裸名（无点）被拒并重问，第二次合法输入被采纳（#119③）', async () => {
    const { io, out } = fakeIo(['2', 'myteam', 'myteam.example.com']);
    expect(await chooseDomain(io)).toBe('myteam.example.com');
    const hint = out.find((l) => l.includes('myteam'));
    expect(hint).toBeDefined();
    expect(hint).toContain('请重输');
  });
  it('选 2 两次都非法 → 显式报错，绝不静默回退 workers.dev（行为变更：决策 #33 非隐性回退，#249）', async () => {
    const { io } = fakeIo(['2', 'myteam', 'bad..name']);
    const p = chooseDomain(io);
    await expect(p).rejects.toThrow(/已停止装配/);
    await expect(p).rejects.toThrow(/未创建任何资源/);
  });
  it('菜单非法连错两次 → 显式报错，不再代选 [1]（行为变更：决策 #33，#249）', async () => {
    const { io } = fakeIo(['9', '8']);
    await expect(chooseDomain(io)).rejects.toThrow(/已停止装配/);
  });
  it('非法输入重问，第二次选 1 → workers.dev（显式选择保留）', async () => {
    const { io } = fakeIo(['9', '1']);
    expect(await chooseDomain(io)).toBeNull();
  });
  it('菜单文案含三选项（对齐 docs/deploy.md）', async () => {
    const { io, out } = fakeIo(['1']);
    await chooseDomain(io);
    expect(out.some((l) => l.includes('[1] workers.dev 免费域名'))).toBe(true);
    expect(out.some((l) => l.includes('[2] 自有域名'))).toBe(true);
  });
});

describe('domainProblem（域名形态体检，#119③）', () => {
  it('合法域名（多级、连字符段）→ null', () => {
    expect(domainProblem('team.example.com')).toBeNull();
    expect(domainProblem('my-team.corp.example.cn')).toBeNull();
  });
  it('裸名（无点）→ 人话提示且复述输入', () => {
    const p = domainProblem('myteam');
    expect(p).toContain('myteam');
    expect(p).toContain('点');
  });
  it('空段（连续点）→ 拒绝', () => {
    expect(domainProblem('a..b')).not.toBeNull();
  });
  it('非法字符/连字符开头结尾 → 拒绝', () => {
    expect(domainProblem('a b.example.com')).not.toBeNull();
    expect(domainProblem('-a.example.com')).not.toBeNull();
    expect(domainProblem('a-.example.com')).not.toBeNull();
  });
});

describe('createAsker（回显卫生，#119②）', () => {
  it('提问间隙到达的行交付时擦一次终端行（TTY→TTY）；正常应答不擦', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    const written: string[] = [];
    output.on('data', (c: Buffer) => written.push(c.toString()));
    const asker = createAsker({ input, output });

    // 提问期间正常应答：逐键回显是内核行规程的事，本包不写擦除控制
    const p1 = asker.ask('→ [1] ');
    input.write('2\n');
    expect(await p1).toBe('2');
    expect(written.join('')).not.toContain('\x1b[1A');

    // 间隙到达（模拟提问期间读配置文件）：入队时擦一次，交付不重放
    input.write('team.example.com\n');
    await new Promise((r) => setImmediate(r));
    expect(written.join('')).toContain('\x1b[1A\r\x1b[0K');
    expect(await asker.ask('  域名 → ')).toBe('team.example.com');
    expect(written.join('').split('\x1b[1A').length).toBe(2); // 只擦一次
    asker.close();
  });

  it('非 TTY（管道）不掺控制符', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (c: Buffer) => written.push(c.toString()));
    const asker = createAsker({ input, output });
    input.write('piped.example\n');
    await new Promise((r) => setImmediate(r));
    expect(await asker.ask('→ ')).toBe('piped.example');
    expect(written.join('')).not.toContain('\x1b');
    asker.close();
  });
});

describe('parseModulesInput（模块覆盖）', () => {
  const available = ['hello', 'meet', 'docs'];
  it('回车 → null（沿用配置默认）', () => {
    expect(parseModulesInput('', available)).toEqual({ ids: null, invalid: [] });
  });
  it('逗号分隔去重保序、trim', () => {
    expect(parseModulesInput(' meet, hello ,meet', available)).toEqual({ ids: ['meet', 'hello'], invalid: [] });
  });
  it('非法 id → null + invalid 携带', () => {
    expect(parseModulesInput('hello,wat', available)).toEqual({ ids: null, invalid: ['wat'] });
  });
  it('纯逗号/空格 = 默认', () => {
    expect(parseModulesInput(' , ', available)).toEqual({ ids: null, invalid: [] });
  });
});

describe('pickTokenDecision（TTY 决策）', () => {
  it('TTY → paste', () => expect(pickTokenDecision(true)).toBe('paste'));
  it('非 TTY → exit', () => expect(pickTokenDecision(false)).toBe('exit'));
});

describe('buildTokenDeepLink（CF 官方模板 URL 格式）', () => {
  it('参数齐全且 JSON 权限集可解码', () => {
    const url = new URL(buildTokenDeepLink());
    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/profile/api-tokens');
    expect(url.searchParams.get('accountId')).toBe('*');
    expect(url.searchParams.get('zoneId')).toBe('all');
    expect(url.searchParams.get('name')).toBe('unself-deploy');
    const perms = JSON.parse(url.searchParams.get('permissionGroupKeys')!) as Array<{ key: string; type: string }>;
    expect(perms).toEqual([
      { key: 'workers_scripts', type: 'edit' },
      { key: 'd1', type: 'edit' },
      { key: 'workers_r2', type: 'edit' },
      { key: 'workers_routes', type: 'edit' },
      { key: 'dns', type: 'edit' },
      { key: 'ssl_and_certificates', type: 'edit' },
    ]);
  });
});

describe('buildTokenFirstScreen（第一屏文案）', () => {
  it('深链接模式：链接 + 粘贴提示（TTY）', () => {
    const lines = buildTokenFirstScreen({ deepLink: 'https://dash.example/x', permissionTable: TOKEN_PERMISSION_TABLE, tty: true });
    expect(lines[0]).toBe('未检测到 CLOUDFLARE_API_TOKEN。');
    expect(lines.join('\n')).toContain('https://dash.example/x');
    expect(lines.join('\n')).toContain('粘贴');
    expect(lines.join('\n')).toContain('不落盘');
  });
  it('退化模式：权限清单表', () => {
    const lines = buildTokenFirstScreen({ deepLink: null, permissionTable: TOKEN_PERMISSION_TABLE, tty: true });
    const text = lines.join('\n');
    expect(text).toContain('profile/api-tokens/create');
    expect(text).toContain('Workers Scripts Edit');
    expect(text).toContain('SSL and Certificates Edit');
  });
  it('非 TTY：人话 + export 指引', () => {
    const lines = buildTokenFirstScreen({ deepLink: 'https://dash.example/x', permissionTable: TOKEN_PERMISSION_TABLE, tty: false });
    const text = lines.join('\n');
    expect(text).toContain('非交互终端');
    expect(text).toContain('export CLOUDFLARE_API_TOKEN=');
  });

  it('TTY：提示可 export 后重跑、粘贴仅本次有效（#119①）', () => {
    const lines = buildTokenFirstScreen({ deepLink: 'https://dash.example/x', permissionTable: TOKEN_PERMISSION_TABLE, tty: true });
    const text = lines.join('\n');
    expect(text).toContain('export CLOUDFLARE_API_TOKEN 再重跑');
    expect(text).toContain('粘贴仅本次有效');
  });
  it('非 TTY 不出现「粘贴仅本次有效」提示（那是给能粘贴的人看的）', () => {
    const lines = buildTokenFirstScreen({ deepLink: 'https://dash.example/x', permissionTable: TOKEN_PERMISSION_TABLE, tty: false });
    expect(lines.join('\n')).not.toContain('粘贴仅本次有效');
  });
});

describe('tokenProblem（token 预校验，#249）', () => {
  it('40 位 base62（首位字母）→ 合法', () => {
    expect(tokenProblem('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0')).toBeNull();
    expect(tokenProblem(' v2SkoDceRewSc5RVEq0L7azPqPQ8M3NiLzTBwbbo5xc ')).toBeNull();
  });
  it('空 → 报空', () => {
    expect(tokenProblem('')).toBe('token 为空');
    expect(tokenProblem('   ')).toBe('token 为空');
  });
  it('带空格/换行 → 提示可能粘了两段', () => {
    expect(tokenProblem('Aaaa bbbb')).toContain('空格');
    expect(tokenProblem('Aaaa\nbbbb')).toContain('空格');
  });
  it('粘了邮箱 → 指认「含字母数字以外字符」', () => {
    expect(tokenProblem('me@example.com')).toContain('字母数字');
  });
  it('首位非字母（数字开头 / 下划线开头）→ 提示形态不像 CF token', () => {
    expect(tokenProblem('1aaaazzzzddddwwwwqqqqeeeerrrrttttyyyy')).toContain('40');
    expect(tokenProblem('_aaaazzzzddddwwwwqqqqeeeerrrrttttyyyy')).toContain('40');
  });
  it('长度 30–50 之外 → 提示长度异常（防少粘一段）', () => {
    expect(tokenProblem(`A${'a'.repeat(29)}`)).toBeNull(); // 30 边界
    expect(tokenProblem(`A${'a'.repeat(28)}`)).toContain('长度'); // 29 位：少粘一段
    expect(tokenProblem(`A${'a'.repeat(49)}`)).toBeNull(); // 50 边界
    expect(tokenProblem(`A${'a'.repeat(50)}`)).toContain('长度');
  });
});

describe('askSecret（可重试 + 预校验，#249）', () => {
  function fakeIo(answers: string[]) {
    const prompts: string[] = [];
    let i = 0;
    return {
      io: {
        ask: (q: string) => {
          prompts.push(q);
          return Promise.resolve(answers[i++] ?? '');
        },
        out: (line: string) => undefined,
      },
      prompts,
    };
  }
  it('第一次有效 → 直接返回（不重问）', async () => {
    const { io } = fakeIo(['A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0']);
    expect(await askSecret(io)).toBe('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0');
  });
  it('前两次无效第三次有效 → 重问两次后收下', async () => {
    const { io, prompts } = fakeIo(['邮箱显然不对', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0']);
    expect(await askSecret(io)).toBe('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0');
    expect(prompts).toHaveLength(2);
  });
  it('三次全无效 → null（调用方走退出指引）；提示逐次递减剩余机会', async () => {
    const { io, prompts } = fakeIo(['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)]);
    expect(await askSecret(io)).toBeNull();
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('3 次机会');
    expect(prompts[2]).toContain('1 次机会');
  });
});

describe('collectToken（掩码采集，#249）', () => {
  const TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
  const savedRef = sttyRef.run;
  const savedStdin = process.stdin;
  const savedStdout = process.stdout;

  afterEach(() => {
    sttyRef.run = savedRef;
    Object.defineProperty(process, 'stdin', { value: savedStdin, writable: true, configurable: true });
    Object.defineProperty(process, 'stdout', { value: savedStdout, writable: true, configurable: true });
  });

  function installFakeTtyAndStty(sink: { calls: string[][] }) {
    sttyRef.run = ((file: string, args: string[], options?: ExecFileSyncOptions) => {
      sink.calls.push([file, ...args]);
      return Buffer.from('');
    }) as unknown as typeof sttyRef.run;
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    output.on('data', () => undefined);
    Object.defineProperty(process, 'stdin', { value: input, writable: true, configurable: true });
    Object.defineProperty(process, 'stdout', { value: output, writable: true, configurable: true });
    return input;
  }

  it('掩码链路：先 stty -echo 再建 asker，收尾恢复 stty echo 且不写明文到共享 stdout', { timeout: 10_000 }, async () => {
    const sink: { calls: string[][] } = { calls: [] };
    const input = installFakeTtyAndStty(sink);
    let resolveToken: (v: string | null) => void = () => undefined;
    const done = new Promise<string | null>((r) => (resolveToken = r));
    void collectToken({ out: () => undefined }, true).then((v) => {
      resolveToken(v);
      return v;
    });
    await new Promise((r) => setTimeout(r, 120)); // echoControl 已发、asker 已建、提问已挂起
    input.write(`${TOKEN}\n`);
    expect(await done).toBe(TOKEN);
    expect(sink.calls.map((c) => c.slice(1).join(' '))).toEqual(['-echo', 'echo']);
  });

  it('三次无效 → null；stty echo 仍在 finally 里恢复', { timeout: 10_000 }, async () => {
    const sink: { calls: string[][] } = { calls: [] };
    const input = installFakeTtyAndStty(sink);
    const p = collectToken({ out: () => undefined }, true);
    await new Promise((r) => setTimeout(r, 120));
    for (const bad of ['x@y.z', '1'.repeat(40), '3'.repeat(40)]) {
      input.write(`${bad}\n`);
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(await p).toBeNull();
    expect(sink.calls.map((c) => c.slice(1).join(' '))).toEqual(['-echo', 'echo']);
  });

  it('ttyIn=false → 完全不碰终端（无 stty 调用）', { timeout: 10_000 }, async () => {
    const sink: { calls: string[][] } = { calls: [] };
    const input = installFakeTtyAndStty(sink);
    const p = collectToken({ out: () => undefined }, false);
    await new Promise((r) => setTimeout(r, 60));
    input.write(`${TOKEN}\n`);
    expect(await p).toBe(TOKEN);
    expect(sink.calls).toEqual([]);
  });
});

describe('echoControl（stty 开关；注入 ref 不碰真终端）', () => {
  const savedRef = sttyRef.run;
  afterEach(() => {
    sttyRef.run = savedRef;
  });
  it('-echo 成功 → 返回 restore；restore 再发 echo', () => {
    const calls: string[][] = [];
    sttyRef.run = ((file: string, args: string[], options?: ExecFileSyncOptions) => {
      calls.push([file, ...args]);
      return Buffer.from('');
    }) as unknown as typeof sttyRef.run;
    const ctl = echoControl('-echo');
    expect(ctl).not.toBeNull();
    ctl!.restore();
    expect(calls).toEqual([['stty', '-echo'], ['stty', 'echo']]);
  });
  it('stty 失败 → 返回 null（降级不阻断）', () => {
    sttyRef.run = (() => {
      throw new Error('spawn stty ENOENT');
    }) as unknown as typeof sttyRef.run;
    expect(echoControl('-echo')).toBeNull();
  });
});
