// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #272：向导① token 接线 + 资源名预览 + `unself deploy` 九步进度/撞车开关。
 *
 * 验收对照：
 * - 向导里粘的 token 真进部署调用（内存），且状态投影里查不到明文；
 * - 向导页/`init` 能看到本实例会占用的资源名；
 * - `unself deploy` 转发九步进度事件；`--allow-adopt` 传给引擎。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWizardServer, type WizardDeps } from '../src/web/server';
import { initialWizardState, type WizardEnvHint, type WizardState } from '../src/web/state';
import { parseArgs, run } from '../src/cli';

const HINT: WizardEnvHint = { hasEnvToken: false, oauthUsable: true, needsTotalTls: false, ci: false };
const TOKEN = `A${'b'.repeat(39)}`; // 合法形态：字母开头、40 位

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unself-272-wiz-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('#272 向导① token 接线', () => {
  it('粘的 token 传给部署调用（内存），状态投影/页面都不出现明文', async () => {
    const holder: { state: WizardState } = {
      state: initialWizardState(join(root, 'demo', 'unself'), {
        modules: ['hello'],
        resourceNames: [{ kind: 'D1（core 库）', name: 'demo-core' }],
      }),
    };
    const captures: Array<Record<string, unknown>> = [];
    const deps: WizardDeps = {
      getState: () => holder.state,
      setState: (s) => {
        holder.state = s;
      },
      hasEnvToken: false,
      envHint: { ...HINT },
      deploy: async (input) => {
        captures.push(input as unknown as Record<string, unknown>);
        input.onEvent('步骤 1/9 替身');
        return { baseUrl: 'https://demo-core-api.workers.dev', setupToken: 'tok' };
      },
    };
    const { server, port } = await new Promise<{ server: ReturnType<typeof createWizardServer>; port: number }>(
      (resolve) => {
        const srv = createWizardServer({ deps });
        srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: (srv.address() as { port: number }).port }));
      },
    );
    const base = `http://127.0.0.1:${port}`;
    const post = async (path: string, body: unknown): Promise<number> => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.status;
    };
    try {
      expect(await post('/api/step1', { token: TOKEN })).toBe(200);
      expect(await post('/api/step2', { choice: 'workers' })).toBe(200);
      expect(await post('/api/step3', { modules: 'hello' })).toBe(200);
      expect(await post('/api/step3b', { choices: {}, sharedConsent: false })).toBe(200);
      expect(await post('/api/step4', { allowAdopt: true })).toBe(202);
      for (let i = 0; i < 50 && captures.length === 0; i++) await new Promise((r) => setTimeout(r, 20));

      expect(captures).toHaveLength(1);
      expect(captures[0]!.token).toBe(TOKEN);
      expect(captures[0]!.allowAdopt).toBe(true);

      const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
      expect(JSON.stringify(st)).not.toContain(TOKEN);
      expect(st.hasToken).toBe(true);

      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain('demo-core'); // 资源名预览段可见
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('#272 init 输出资源名 + deploy 进度/撞车开关', () => {
  function opts(argv: string[], extra?: Record<string, unknown>) {
    const out: string[] = [];
    const errs: string[] = [];
    return {
      argv,
      env: {} as { UNSELF_INSTANCE?: string; CLOUDFLARE_API_TOKEN?: string },
      home: join(root, 'home'),
      cwd: root,
      log: (l: string) => out.push(l),
      err: (l: string) => errs.push(l),
      out,
      errs,
      ...extra,
    };
  }

  it('init 打印命名空间派生出的资源名（含 D1/Worker/R2）', async () => {
    const o = opts(['init', 'mysite', join(root, 'mysite')]);
    await run(o);
    const text = o.out.join('\n');
    expect(o.errs).toEqual([]);
    expect(text).toContain('mysite-core');
    expect(text).toContain('mysite-workbench');
    expect(text).toContain('mysite-storage');
  });

  it('deploy 转发九步事件 + --allow-adopt 传给引擎', async () => {
    await run(opts(['init', 'mysite', join(root, 'mysite')]));
    const captured: Array<Record<string, unknown>> = [];
    const o = opts(['deploy', '--allow-adopt'], {
      deployNineSteps: async (input: Record<string, unknown>) => {
        captured.push(input);
        (input.onEvent as (t: string) => void)?.('步骤 3/9 构建上传 Shell Worker');
        return { baseUrl: 'https://mysite-workbench.workers.dev', setupToken: 'tok' };
      },
    });
    await run(o);
    expect(o.errs).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.allowAdopt).toBe(true);
    expect(o.out.join('\n')).toContain('步骤 3/9 构建上传 Shell Worker');
    expect(o.out.join('\n')).toContain('装配完成：https://mysite-workbench.workers.dev');
  });

  it('parseArgs 识别 --allow-adopt / --allow-shared-account 且不污染位置参数', () => {
    expect(parseArgs(['deploy', '--allow-adopt'])).toMatchObject({ cmd: 'deploy', args: [], allowAdopt: true });
    expect(parseArgs(['deploy', '--allow-shared-account'])).toMatchObject({ cmd: 'deploy', allowAdopt: true });
    expect(parseArgs(['list', '--json'])).toMatchObject({ cmd: 'list', json: true, allowAdopt: false });
  });
});
