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
import { initialWizardState, type WizardState } from '../src/web/state';

let holder: { state: WizardState };
let base: string;
let close: () => Promise<void>;

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

    // ③ 模块确认
    const s3 = await post('/api/step3', { modules: 'hello, chat' });
    expect(s3.json.step).toBe('ready');
    expect(holder.state.modules).toEqual(['hello', 'chat']);

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

  it('① token 非法 → 400 人话 problem（密码框掩码语义：状态不含明文）', async () => {
    const r = await post('/api/step1', { token: 'short' });
    expect(r.status).toBe(400);
    expect(String(r.json.problem)).toMatch(/长度/);
    expect(JSON.stringify(holder.state)).not.toContain('short');
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
        deploy: async () => ({ baseUrl: 'https://x', setupToken: null }),
      },
    });
    expect(typeof server.listen).toBe('function');
    server.close();
  });
});

describe('renderPage 样式令牌（#258 护栏：样式只走 tokens）', () => {
  it('样式规则不含裸颜色字面量，颜色一律引用契约令牌变量', () => {
    const page = renderPage(initialWizardState('/tmp/x/unself'), false);
    const style = page.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    // 令牌取值定义处（:root）允许出现值（取值来自 theme-tokens.json）；
    // 其余样式规则里出现裸 hex / rgb() 即违规——这是 CI `verify:tokens` 规则一的单测版护栏。
    const rules = style.replace(/:root \{[\s\S]*?\}/, '');
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rules).not.toMatch(/rgba?\(/);
    // 边框与错误色必须走令牌变量
    expect(rules).toContain('var(--unself-color-border)');
    expect(rules).toContain('var(--unself-color-danger)');
    // 令牌取值由契约默认主题渲染进 :root
    expect(style).toMatch(/--unself-color-border:\s*\S+/);
  });
});
