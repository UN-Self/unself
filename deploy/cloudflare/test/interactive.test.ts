// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  buildTokenDeepLink,
  buildTokenFirstScreen,
  chooseDomain,
  createAsker,
  domainProblem,
  parseCliArgs,
  parseModulesInput,
  pickTokenDecision,
  resolveDomainChoice,
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
  it('未知参数忽略', () => {
    expect(parseCliArgs(['--wat', '-x', '--domain=d'])).toEqual({ domain: 'd', yes: false });
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
  it('选 2 两次都非法 → 放弃自有域回退 workers.dev（null）', async () => {
    const { io } = fakeIo(['2', 'myteam', 'bad..name']);
    expect(await chooseDomain(io)).toBeNull();
  });
  it('非法输入重问后默认 1', async () => {
    const { io } = fakeIo(['9', '']);
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
