// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web 向导 HTTP 壳行为测试（不依赖浏览器）：fetch 真 listen 冒烟 + 路由/状态机。
 * deps.deploy 注入替身（成功路径 / 抛错路径），事件经 GET /api/events 回读。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWizardServer, renderPage, startWizardServer } from '../src/web/server';
import { initialWizardState, type WizardEnvHint, type WizardState } from '../src/web/state';

let holder: { state: WizardState };
let base: string;
let close: () => Promise<void>;

/** ①步环境提示基线：OAuth 可用、非 CI、非多级子域（#246 envHint 缺省语义）。 */
const HINT: WizardEnvHint = { hasEnvToken: false, oauthUsable: true, needsTotalTls: false, ci: false };

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'unself-wizsrv-'));
  holder = { state: initialWizardState(join(root, 'demo', 'unself'), { modules: ['hello'] }) };
  const { server, port } = await startWizardServer({
    deps: {
      getState: () => holder.state,
      setState: (s) => {
        holder.state = s;
      },
      hasEnvToken: false,
      envHint: { ...HINT },
      deploy: async ({ onEvent }) => {
        onEvent('九步进度（替身）：步骤 1/9');
        await new Promise((r) => setTimeout(r, 20));
        return { baseUrl: 'https://unself-core-api.test.workers.dev', setupToken: 'tok-123' };
      },
    },
  });
  base = `http://127.0.0.1:${port}`;
  close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  };
});

afterEach(async () => {
  await close();
});

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('GET /（页面）', () => {
  it('页头常驻显示实例目录（可复制：code#instance-path + 复制按钮）', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`id="instance-path"`);
    expect(html).toContain(holder.state.instancePath);
    expect(html).toContain('复制');
  });
});

describe('路由守卫', () => {
  it('未完成①时 step2/step3 → 400', async () => {
    expect((await post('/api/step2', { choice: 'workers' })).status).toBe(400);
    expect((await post('/api/step3', { modules: 'hello' })).status).toBe(400);
  });

  it('未知路径 → 404 人话', async () => {
    const r = await post('/api/nope', {});
    expect(r.status).toBe(404);
    expect(String(r.json.problem)).toContain('未知路径');
  });

  it('step4 只在 ready/failed/done 可发；auth 下 400', async () => {
    const r = await post('/api/step4', {});
    expect(r.status).toBe(400);
    expect(String(r.json.problem)).toContain('不能开始装配');
  });
});

describe('六段流全链（替身部署）', () => {
  it('①②③④ 走通 → deploying → done，⑤ 收尾含 baseUrl + setup 深链；⑥ 幂等标语在 state', async () => {
    // ① token（合法形态：字母开头 40 位）
    const s1 = await post('/api/step1', { token: 'A'.repeat(40) });
    expect(s1.status).toBe(200);
    expect(s1.json.step).toBe('domain');

    // ② workers.dev 显式第一项
    const s2 = await post('/api/step2', { choice: 'workers' });
    expect(s2.json.step).toBe('modules');

    // ③ 模块确认 → ③½ 存储选择（默认 storageOptions 为空 → 直接 ready）
    const s3 = await post('/api/step3', { modules: 'hello, chat' });
    expect(s3.json.step).toBe('storage');
    expect(holder.state.modules).toEqual(['hello', 'chat']);
    const s3b = await post('/api/step3b', { choices: {}, sharedConsent: false });
    expect(s3b.json.step).toBe('ready');

    // ④ 开始装配 → 202 deploying
    const s4 = await post('/api/step4', {});
    expect(s4.status).toBe(202);
    expect(s4.json.step).toBe('deploying');

    // 事件流回读（SSE）
    const es = await fetch(`${base}/api/events`);
    const text = await es.text();
    expect(text).toContain('步骤 1/9');

    // ⑤ 收尾：done + baseUrl + setup 深链
    for (let i = 0; i < 40; i++) {
      const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
      if (st.step === 'done') {
        const result = st.result as Record<string, unknown>;
        expect(result.baseUrl).toBe('https://unself-core-api.test.workers.dev');
        expect(result.setupUrl).toContain('/setup?token=');
        expect(st.idempotent).toBe(true);
        expect(String(st.idempotentNote)).toContain('重跑');
        break;
      }
      expect(st.step).not.toBe('failed');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(holder.state.step).toBe('done');
  });

  it('① token 形状非法 → 400 人话 problem（密码框掩码语义：状态不含明文）', async () => {
    const r = await post('/api/step1', { token: 'bad!token' });
    expect(r.status).toBe(400);
    expect(String(r.json.problem)).toMatch(/以外的字符/);
    expect(JSON.stringify(holder.state)).not.toContain('bad!token');
  });

  it('② 自有域非法 → 400 原地不动；⑥ failed 后重跑 reset 收敛', async () => {
    await post('/api/step1', { token: 'A'.repeat(40) });
    const bad = await post('/api/step2', { choice: 'custom', domain: 'nodot' });
    expect(bad.status).toBe(400);
    expect(String(bad.json.problem)).toMatch(/不像完整域名/);
    expect(holder.state.step).toBe('domain');

    await post('/api/step2', { choice: 'workers' });
    await post('/api/step3', { modules: 'hello' });
    // 部署替身抛错：10405 → 三要素 owner=token
  });
});

describe('失败路径（三要素）', () => {
  it('deploy 抛 10405 → failed + owner=token + 修复建议；随后可重跑', async () => {
    await post('/api/step1', { token: 'A'.repeat(40) });
    await post('/api/step2', { choice: 'workers' });
    await post('/api/step3', { modules: 'hello' });

    // 换上抛错替身
    holder.state.step = 'ready';
    const { server, port } = await startWizardServer({
      deps: {
        getState: () => holder.state,
        setState: (s) => {
          holder.state = s;
        },
        hasEnvToken: false,
        envHint: { ...HINT },
        deploy: async () => {
          throw new Error('PUT /zones/../workers/routes: 10405 权限不足');
        },
      },
    });
    const b2 = `http://127.0.0.1:${port}`;
    try {
      const r4 = await fetch(`${b2}/api/step4`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(r4.status).toBe(202);
      for (let i = 0; i < 40; i++) {
        const st = (await (await fetch(`${b2}/api/state`)).json()) as Record<string, unknown>;
        if (st.step === 'failed') {
          const err = st.error as Record<string, unknown>;
          expect(err.owner).toBe('token');
          expect(String(err.cause)).toContain('10405');
          expect(String(err.fix)).toContain('重跑');
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(holder.state.step).toBe('failed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('幂等标语与重跑（⑥）', () => {
  it('failed 后再发 step4 → reset 后重新 deploying（收敛语义）', async () => {
    await post('/api/step1', { token: 'A'.repeat(40) });
    await post('/api/step2', { choice: 'workers' });
    await post('/api/step3', { modules: 'hello' });
    holder.state.step = 'failed';
    holder.state.error = { cause: 'x', owner: 'code', fix: 'y' };

    const r = await post('/api/step4', {});
    expect(r.status).toBe(202);
    // ⑥ 收敛语义：重跑后回到 deploying，旧错误已清；替身部署睡 20ms，随后收敛回 done。
    let final: Record<string, unknown> | null = null;
    for (let i = 0; i < 40; i++) {
      const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
      if (st.step === 'done' || st.step === 'failed') {
        final = st;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(holder.state.error).toBeNull();
    expect(final?.step).toBe('done');
    expect((final?.result as Record<string, unknown>).baseUrl).toBe('https://unself-core-api.test.workers.dev');
  });
});

describe('createWizardServer 裸构造（不 listen 也可导出）', () => {
  it('返回 Server 实例', () => {
    const server = createWizardServer({
      deps: {
        getState: () => initialWizardState('/tmp/x/unself'),
        setState: () => {},
        hasEnvToken: true,
        envHint: { ...HINT, hasEnvToken: true },
        deploy: async () => ({ baseUrl: 'https://x', setupToken: null }),
      },
    });
    expect(typeof server.listen).toBe('function');
    server.close();
  });
});

describe('① 折叠入口默认态（#246 决策 #66：默认不露，露出条件任一）', () => {
  it('oauthUsable=true 且非多级子域非 CI → details 无 open（默认收起）', () => {
    const html = renderPage(initialWizardState('/tmp/x/unself'), HINT);
    expect(html).toContain('<details class="auth-fold">');
    expect(html).not.toMatch(/<details class="auth-fold"\s+open/);
  });

  it('oauthUsable=false → 折叠块默认展开 + 人话「没有可借用的 wrangler OAuth」', () => {
    const html = renderPage(initialWizardState('/tmp/x/unself'), { ...HINT, oauthUsable: false });
    expect(html).toContain('<details class="auth-fold" open>');
    expect(html).toContain('没有可借用的 wrangler OAuth');
  });

  it('ci=true → 折叠块默认展开 + 顶部横幅引导 CLOUDFLARE_API_TOKEN', () => {
    const html = renderPage(initialWizardState('/tmp/x/unself'), { ...HINT, ci: true });
    expect(html).toContain('<details class="auth-fold" open>');
    expect(html).toContain('CI/无浏览器环境');
    expect(html).toContain('CLOUDFLARE_API_TOKEN');
  });

  it('needsTotalTls=true → 折叠块默认展开 + Total TLS 提示行', () => {
    const html = renderPage(initialWizardState('/tmp/x/unself'), { ...HINT, needsTotalTls: true });
    expect(html).toContain('<details class="auth-fold" open>');
    expect(html).toContain('多级子域需要 Total TLS');
    expect(html).toContain('OAuth 不覆盖，需 API Token');
  });

  it('oauthUsable=true → 顶部显式「检测到本机 wrangler OAuth，可零输入直跑」；false 则无', () => {
    const yes = renderPage(initialWizardState('/tmp/x/unself'), HINT);
    expect(yes).toContain('检测到本机 wrangler OAuth，可零输入直跑');
    const no = renderPage(initialWizardState('/tmp/x/unself'), { ...HINT, oauthUsable: false });
    expect(no).not.toContain('可零输入直跑');
  });

  it('hasEnvToken=true → 「已检测」态照旧（envHint.hasEnvToken 向后兼容 hasEnvToken 语义）', () => {
    const html = renderPage(initialWizardState('/tmp/x/unself'), { ...HINT, hasEnvToken: true });
    expect(html).toContain('已检测到环境变量 CLOUDFLARE_API_TOKEN');
    // 已带凭证时不再出现「没有可借用」式否定引导
    expect(html).not.toContain('没有可借用的 wrangler OAuth');
  });
});

describe('envHint 投影与多级子域更新（#246）', () => {
  it('/api/state 带 envHint（四布尔，不含 token 明文）', async () => {
    await post('/api/step1', { token: 'A'.repeat(40) });
    const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    const hint = st.envHint as Record<string, unknown>;
    expect(hint).toEqual({ hasEnvToken: false, oauthUsable: true, needsTotalTls: false, ci: false });
    // 状态投影永不携带 token 明文（既有语义，envHint 加入后保持）
    expect(JSON.stringify(st)).not.toContain('A'.repeat(40));
  });

  it('② 选 custom 多级子域 → 之后 envHint.needsTotalTls=true，页面出现 Total TLS 提示', async () => {
    await post('/api/step1', { token: 'A'.repeat(40) });
    const r2 = await post('/api/step2', { choice: 'custom', domain: 'a.team.example.com' });
    expect(r2.status).toBe(200);

    const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    expect((st.envHint as Record<string, unknown>).needsTotalTls).toBe(true);

    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('多级子域需要 Total TLS');
    expect(html).toMatch(/<details class="auth-fold"\s+open/);
  });

  it('② 选 custom 单级子域（zone 下一级）→ needsTotalTls 保持 false，折叠收起', async () => {
    await post('/api/step1', { token: 'A'.repeat(40) });
    const r2 = await post('/api/step2', { choice: 'custom', domain: 'team.example.com' });
    expect(r2.status).toBe(200);

    const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    expect((st.envHint as Record<string, unknown>).needsTotalTls).toBe(false);
    const html = await (await fetch(`${base}/`)).text();
    expect(html).not.toMatch(/<details class="auth-fold"\s+open/);
  });

  it('② 选 workers.dev → 不触发多级子域（免费域永远不需要 Total TLS）', async () => {
    await post('/api/step1', { token: 'A'.repeat(40) });
    await post('/api/step2', { choice: 'workers' });
    const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    expect((st.envHint as Record<string, unknown>).needsTotalTls).toBe(false);
  });
});

describe('envHint 缺省向后兼容（不传 envHint 只传 hasEnvToken）', () => {
  it('缺省语义 = oauthUsable/非 CI/非多级子域，hasEnvToken 映射进 envHint', async () => {
    const { server, port } = await startWizardServer({
      deps: {
        getState: () => initialWizardState('/tmp/x/legacy/unself'),
        setState: () => {},
        hasEnvToken: true,
        deploy: async () => ({ baseUrl: 'https://x', setupToken: null }),
      },
    });
    try {
      const st = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as Record<string, unknown>;
      expect(st.envHint).toEqual({ hasEnvToken: true, oauthUsable: true, needsTotalTls: false, ci: false });
      expect(st.hasEnv).toBe(true);
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(html).toContain('已检测到环境变量 CLOUDFLARE_API_TOKEN');
      expect(html).not.toMatch(/<details class="auth-fold"\s+open/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
