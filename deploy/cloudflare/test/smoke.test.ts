// SPDX-License-Identifier: AGPL-3.0-only
/**
 * smokeCheck（§5.3 单域名路径制）行为测试。
 * 只 stub 网络层（vi.stubGlobal('fetch', ...)）捕获请求 URL，真实调用 src/smoke.ts 的 smokeCheck：
 * - URL 形态：domain 与 workers.dev 两种 baseUrl 均走 <baseUrl>/api/health 与 <baseUrl>/m/<id>/api/health
 *   （无 <id>. 子域分支），core 在前、模块按 moduleIds 顺序；
 * - 行为：200+ok:true、200 缺 ok:true（detail「响应体缺 ok:true」）、非 200（detail「HTTP 503」且不解析 JSON）、
 *   fetch 抛错（detail 以「不可达：」开头、status=0）、多模块混合按 moduleIds 顺序返回且失败项不影响成功项。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { checkModuleThemes, generateSetupToken, parseD1Rows, parseWorkersDevFromDeployOutput, provisionSetupToken, smokeCheck } from '../src/smoke';
import type { Wrangler } from '../src/wrangler';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(
  impl: (input: Parameters<typeof fetch>[0]) => Promise<Response>,
): Mock<(input: Parameters<typeof fetch>[0]) => Promise<Response>> {
  const m = vi.fn(impl);
  vi.stubGlobal('fetch', m);
  return m;
}

describe('smokeCheck 请求 URL 形态（§5.3 单域名路径制）', () => {
  it('domain 模式：core 在前，模块按 moduleIds 顺序，均拼在 baseUrl 后', async () => {
    const captured: string[] = [];
    const m = stubFetch(async (input) => {
      captured.push(String(input));
      return jsonResponse(200, { ok: true });
    });
    const results = await smokeCheck({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(m).toHaveBeenCalledTimes(2);
    expect(captured).toEqual([
      'https://demo.handywote.top/api/health',
      'https://demo.handywote.top/m/hello/api/health',
    ]);
    expect(results.map((r) => r.name)).toEqual(['core-api', 'module:hello']);
  });

  it('workers.dev 模式：三个请求全部同 host 路径制，无 <id>. 子域分支', async () => {
    const captured: string[] = [];
    stubFetch(async (input) => {
      captured.push(String(input));
      return jsonResponse(200, { ok: true });
    });
    await smokeCheck({
      baseUrl: 'https://unself-core-api.test-subdomain.workers.dev',
      moduleIds: ['hello', 'meet'],
    });
    expect(captured).toEqual([
      'https://unself-core-api.test-subdomain.workers.dev/api/health',
      'https://unself-core-api.test-subdomain.workers.dev/m/hello/api/health',
      'https://unself-core-api.test-subdomain.workers.dev/m/meet/api/health',
    ]);
  });
});

describe('smokeCheck 行为断言', () => {
  it('200 且 body {ok:true}：每项 ok=true、status=200、detail 缺省', async () => {
    stubFetch(async () => jsonResponse(200, { ok: true }));
    const results = await smokeCheck({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: true, status: 200, detail: undefined },
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/api/health', ok: true, status: 200, detail: undefined },
    ]);
  });

  it('200 但 body 缺 ok:true（{}）：ok=false，detail 恰为「响应体缺 ok:true」', async () => {
    stubFetch(async () => jsonResponse(200, {}));
    const results = await smokeCheck({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: false, status: 200, detail: '响应体缺 ok:true' },
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/api/health', ok: false, status: 200, detail: '响应体缺 ok:true' },
    ]);
  });

  it('非 200（503）：ok=false、status=503、detail「HTTP 503」，且不尝试解析 JSON', async () => {
    const jsonSpy = vi.fn(async () => {
      throw new Error('非 200 分支不应调用 res.json()');
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 503, json: jsonSpy }) as unknown as Response));
    const results = await smokeCheck({ baseUrl: 'https://demo.handywote.top', moduleIds: [] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: false, status: 503, detail: 'HTTP 503' },
    ]);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('fetch 抛错（网络不可达）：ok=false、status=0、detail 以「不可达：」开头', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const results = await smokeCheck({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: false, status: 0, detail: expect.stringMatching(/^不可达：/) },
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/api/health', ok: false, status: 0, detail: expect.stringMatching(/^不可达：/) },
    ]);
  });

  it('多模块混合：一项成功一项失败，返回数组按 moduleIds 顺序且失败项不影响成功项', async () => {
    stubFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/m/meet/api/health')) return jsonResponse(503, { error: 'boom' });
      return jsonResponse(200, { ok: true });
    });
    const results = await smokeCheck({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello', 'meet'] });
    expect(results).toEqual([
      { name: 'core-api', url: 'https://demo.handywote.top/api/health', ok: true, status: 200, detail: undefined },
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/api/health', ok: true, status: 200, detail: undefined },
      { name: 'module:meet', url: 'https://demo.handywote.top/m/meet/api/health', ok: false, status: 503, detail: 'HTTP 503' },
    ]);
  });
});

describe('步骤⑧ 本地签发（#165 方案 B：不再 POST /api/admin/setup-token）', () => {
  beforeEach(() => {
    // 硬边界：步骤⑧ 全程不发起 HTTP（签发已收归装配器 + d1 execute）
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('步骤⑧不应发起 HTTP');
      }),
    );
  });

  /** 真 wrangler v4.129.0 `d1 execute --json` 形状（本地 D1 实测夹具）。 */
  const d1Json = (rows: Array<Record<string, unknown>>) =>
    JSON.stringify([{ results: rows, success: true, meta: { duration: 0 } }]);

  /** 录制型 stub wrangler：按调用序回放 stdout。 */
  function stubWrangler(outputs: string[]): { wrangler: Wrangler; commands: string[] } {
    const commands: string[] = [];
    let i = 0;
    const run = async (args: string[]) => {
      commands.push(args.join(' '));
      const stdout = outputs[Math.min(i, outputs.length - 1)] ?? '';
      i++;
      return { ok: true, code: 0, stdout, stderr: '' };
    };
    return { wrangler: { run, tryRun: run }, commands };
  }

  it('generateSetupToken：24B → 32 字符 base64url（URL 安全、无填充、两次不同）', () => {
    const a = generateSetupToken();
    const b = generateSetupToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });

  it('未封箱且无既有 token：INSERT 写入 core 库（--remote + 生成配置 + --json），返回相对 setupUrl', async () => {
    const { wrangler, commands } = stubWrangler([d1Json([{ sealed: 0, token: null }]), d1Json([])]);
    const result = await provisionSetupToken({ wrangler, configPath: '/repo/.deploy/migrate/core.wrangler.jsonc' });
    expect(result).toMatchObject({ setupUrl: expect.stringMatching(/^\/setup\?token=[A-Za-z0-9_-]{32}$/) });
    const token = 'token' in result ? result.token : '';
    expect(commands[0]).toContain('SELECT');
    expect(commands[0]).toContain('--remote');
    expect(commands[0]).toContain('--config /repo/.deploy/migrate/core.wrangler.jsonc');
    expect(commands[1]).toBe(
      `d1 execute CORE_DB --command INSERT INTO setup_tokens (token) VALUES ('${token}') -y --remote --config /repo/.deploy/migrate/core.wrangler.jsonc --json`,
    );
  });

  it('已有未消费 token：复用且不再 INSERT（重跑幂等，链接不变）', async () => {
    const { wrangler, commands } = stubWrangler([d1Json([{ sealed: 0, token: 'tok-existing' }])]);
    const result = await provisionSetupToken({ wrangler, configPath: '/cfg.jsonc' });
    expect(result).toEqual({ token: 'tok-existing', setupUrl: '/setup?token=tok-existing' });
    expect(commands).toHaveLength(1);
  });

  it('已封箱：回 sealed，且不 INSERT', async () => {
    const { wrangler, commands } = stubWrangler([d1Json([{ sealed: 1, token: null }])]);
    const result = await provisionSetupToken({ wrangler, configPath: '/cfg.jsonc' });
    expect(result).toEqual({ sealed: true });
    expect(commands).toHaveLength(1);
  });

  it('标准输出带前缀日志行：仍能解析出 results（不误判为未封箱）', async () => {
    expect(parseD1Rows(`Cloudflare 登录提示\n${d1Json([{ sealed: 1, token: null }])}`)).toEqual([
      { sealed: 1, token: null },
    ]);
    const { wrangler, commands } = stubWrangler([`日志行\n${d1Json([{ sealed: 1, token: null }])}`]);
    expect(await provisionSetupToken({ wrangler, configPath: '/cfg.jsonc' })).toEqual({ sealed: true });
    expect(commands).toHaveLength(1);
  });

  it('空/不可解析输出：按未封箱处理并签发（不阻断新部署）', async () => {
    expect(parseD1Rows('')).toEqual([]);
    const { wrangler, commands } = stubWrangler(['', d1Json([])]);
    const result = await provisionSetupToken({ wrangler, configPath: '/cfg.jsonc' });
    expect('token' in result).toBe(true);
    expect(commands).toHaveLength(2);
  });
});

describe('checkModuleThemes（部署期主题体检 · §6.5.8 验产物，不验源码）', () => {
  it('URL 形态 = <baseUrl>/m/<id>/（模块页根路径，与用户实际加载相同）', async () => {
    const captured: string[] = [];
    const m = stubFetch(async (input) => {
      captured.push(String(input));
      return new Response('<html>ok</html>');
    });
    const results = await checkModuleThemes({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(m).toHaveBeenCalledTimes(1);
    expect(captured).toEqual(['https://demo.handywote.top/m/hello/']);
    expect(results.map((r) => r.name)).toEqual(['module:hello']);
  });

  it('HTML 只用白名单 var（var(--unself-color-primary)/var(--unself-space-4)）→ ok:true、skinned:false、unknown=[]', async () => {
    stubFetch(async () =>
      new Response(`<html><body><div style="color: var(--unself-color-primary); margin: var(--unself-space-4)">x</div></body></html>`),
    );
    const results = await checkModuleThemes({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results).toEqual([
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/', ok: true, skinned: false, unknown: [] },
    ]);
  });

  it('HTML 含 var(--color-primary) 或 var(--unself-space4)（未解析）→ ok:false 且 unknown 列出', async () => {
    stubFetch(async () =>
      new Response(`<style>a { color: var(--color-primary); margin: var(--unself-space4); }</style>`),
    );
    const results = await checkModuleThemes({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results[0]).toMatchObject({
      name: 'module:hello',
      url: 'https://demo.handywote.top/m/hello/',
      ok: false,
      skinned: false,
    });
    expect(results[0]?.unknown).toEqual(['--color-primary', '--unself-space4']);
    expect(results[0]?.detail).toBeUndefined();
  });

  it('零 --unself-* 引用（独立皮肤）→ ok:true、skinned:true、unknown=[]（标注不红）', async () => {
    stubFetch(async () => new Response('<html><body><p>独立皮肤自带样式</p></body></html>'));
    const results = await checkModuleThemes({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results).toEqual([
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/', ok: true, skinned: true, unknown: [] },
    ]);
  });

  it('fetch 抛错（网络不可达）→ ok:false、skinned=false、unknown=[]、detail 以「不可达：」开头', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const results = await checkModuleThemes({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello'] });
    expect(results).toEqual([
      { name: 'module:hello', url: 'https://demo.handywote.top/m/hello/', ok: false, skinned: false, unknown: [], detail: expect.stringMatching(/^不可达：/) },
    ]);
  });

  it('多模块：按 moduleIds 顺序逐页体检，一页失败（未解析令牌）不影响其它页收集', async () => {
    stubFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/m/todo/')) return new Response('<style>a{color:var(--unsafe-color)}</style>');
      return new Response('<style>a{color:var(--unself-color-primary)}</style>');
    });
    const results = await checkModuleThemes({ baseUrl: 'https://demo.handywote.top', moduleIds: ['hello', 'todo'] });
    expect(results.map((r) => r.name)).toEqual(['module:hello', 'module:todo']);
    expect(results[0]).toMatchObject({ ok: true, skinned: false, unknown: [] });
    expect(results[1]).toMatchObject({ ok: false, skinned: false });
    expect(results[1]?.unknown).toEqual(['--unsafe-color']);
  });
});

describe('parseWorkersDevFromDeployOutput（workers.dev 主路径直测，T3）', () => {
  it('wrangler v4 真实部署输出形状：Deployed … https://<name>.workers.dev → 抓到完整 URL', () => {
    // wrangler v4.129.x `wrangler deploy` 实际 stdout（fake wrangler 回放同款，steps.test.ts 部署行）
    const stdout = [
      '⛅️ wrangler v4.29.1',
      '------------------',
      'Total Upload: 123.45 KiB / Compression: 34.56 KiB',
      'Uploaded unself-core-api (3.41 sec)',
      'Deployed unself-core-api triggers (1.18 sec)',
      '  https://unself-core-api.test-subdomain.workers.dev',
      '',
    ].join('\n');
    expect(parseWorkersDevFromDeployOutput(stdout)).toBe(
      'https://unself-core-api.test-subdomain.workers.dev',
    );
  });

  it('输出含多行日志与杂项 URL：仍只抓 .workers.dev 域（不误抓 dash/others）', () => {
    const stdout = [
      '🌀 Building list of candidate versions...',
      '🌎 ⚠️ No custom domain detected, using workers.dev',
      '参考文档: https://developers.cloudflare.com/workers/',
      'Deployed unself-core-api triggers',
      '  https://unself-core-api.a1b2c3d4.workers.dev',
    ].join('\n');
    expect(parseWorkersDevFromDeployOutput(stdout)).toBe(
      'https://unself-core-api.a1b2c3d4.workers.dev',
    );
  });

  it('输出无 workers.dev URL（如仅报错/登录提示）→ null（调用方走「无法解析」人话分支）', () => {
    expect(parseWorkersDevFromDeployOutput('⛅️ wrangler v4.29.1\nNot logged in, run `wrangler login`')).toBeNull();
    expect(parseWorkersDevFromDeployOutput('')).toBeNull();
  });
});

describe('provisionSetupToken 生产默认路径（wrangler 失败即硬失败，T3）', () => {
  it('探测命令非零退出（wrangler 报错）→ WranglerError 带命令与 stderr 硬失败（不静默误签）', async () => {
    // 生产真实路径：run() 对非零退出抛 WranglerError（wrangler.ts）。探测失败必须硬失败——
    // 若误把「探测失败」当「空输出」，会按未封箱处理在错误账户上凭空 INSERT。
    // 这里用真实 WranglerError 形状（非 fake 回放）验证错误面含命令与 stderr 人话。
    const commands: string[] = [];
    const wrangler: Wrangler = {
      run: async (args) => {
        commands.push(args.join(' '));
        throw Object.assign(new Error('d1 execute 失败（1）\n  命令: wrangler d1 execute CORE_DB --command SELECT ...\n  stderr: failed to fetch D1: network unreachable'), { name: 'WranglerError' });
      },
      tryRun: async (args) => {
        commands.push(args.join(' '));
        return { ok: false, code: 1, stdout: '', stderr: 'x' };
      },
    };
    await expect(
      provisionSetupToken({ wrangler, configPath: '/cfg.jsonc' }),
    ).rejects.toThrow(/failed to fetch D1: network unreachable/);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('SELECT');
  });
});
