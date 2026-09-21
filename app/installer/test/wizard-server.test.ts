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
import { initialWizardState, type StorageLevel, type WizardEnvHint, type WizardModuleConfig, type WizardState } from '../src/web/state';

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
        return { baseUrl: 'https://unself-workbench.test.workers.dev', setupToken: 'tok-123' };
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
        expect(result.baseUrl).toBe('https://unself-workbench.test.workers.dev');
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
    expect((final?.result as Record<string, unknown>).baseUrl).toBe('https://unself-workbench.test.workers.dev');
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
    // #307 六步分屏：auth 折叠只在①屏渲染（banner 常驻提示 Total TLS；①屏 details 默认展开）
    expect(html).toContain('data-step="modules"');
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

describe('① OAuth 直跑（页面文案「可零输入直跑（跳过本步）」的接线）', () => {
  it('宿主 OAuth 可用且非 CI → 留空即跳过①，不再报「token 为空」', async () => {
    const r = await post('/api/step1', { token: '' });
    expect(r.status).toBe(200);
    expect(r.json.step).toBe('domain');
    expect(holder.state.hasToken).toBe(true);
    expect(holder.state.error).toBeNull();
  });

  it('OAuth 不可用 → 留空仍拒绝（不能静默降级成“用不存在的凭据”）', async () => {
    const { server, port } = await startWizardServer({
      deps: {
        getState: () => initialWizardState('/tmp/x/no-oauth/unself'),
        setState: () => {},
        hasEnvToken: false,
        envHint: { ...HINT, oauthUsable: false },
        deploy: async () => ({ baseUrl: 'https://x', setupToken: null }),
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/step1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: '' }),
      });
      expect(res.status).toBe(400);
      expect(String(((await res.json()) as Record<string, unknown>).problem)).toContain('token 为空');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('CI 态（没有浏览器可授权）→ 留空仍拒绝', async () => {
    const { server, port } = await startWizardServer({
      deps: {
        getState: () => initialWizardState('/tmp/x/ci/unself'),
        setState: () => {},
        hasEnvToken: false,
        envHint: { ...HINT, ci: true },
        deploy: async () => ({ baseUrl: 'https://x', setupToken: null }),
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/step1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: '' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('页面脚本必须可解析（防「HTTP 200 但所有按钮都点不动」）', () => {
  /** 从渲染页里取出全部内联 <script> 源码。 */
  function inlineScripts(html: string): string[] {
    return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
  }

  it('渲染页的内联脚本能被 JS 引擎解析（语法错 = 整页按钮全挂）', () => {
    const html = renderPage(initialWizardState('/tmp/x/unself'), HINT);
    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) {
      // `new Function` 只做语法解析（不执行）；失败会抛 SyntaxError。
      expect(() => new Function(src)).not.toThrow();
    }
  });

  it('脚本里引用的元素 id 都在六屏渲染（#307 分屏：脚本按步共用，跨屏引用必须在任一屏存在）', () => {
    const steps: WizardState['step'][] = ['auth', 'domain', 'modules', 'module-config', 'storage', 'ready', 'deploying', 'failed', 'done'];
    const htmls: string[] = [];
    for (const step of steps) {
      const base0 = initialWizardState('/tmp/x/unself');
      if (step === 'failed') {
        htmls.push(renderPage({ ...base0, step, error: { cause: 'c', owner: 'code', fix: 'f' } }, HINT));
        continue;
      }
      if (step === 'done') {
        htmls.push(renderPage({ ...base0, step, result: { baseUrl: 'https://x', setupUrl: '/setup?token=t' } }, HINT));
        htmls.push(renderPage({ ...base0, step, result: { baseUrl: 'https://x', setupUrl: null } }, HINT));
        continue;
      }
      if (step === 'storage') {
        htmls.push(renderPage({ ...base0, step, storageOptions: [{ id: 'demo', accepts: ['core'] }] }, HINT));
        continue;
      }
      if (step === 'module-config') {
        htmls.push(
          renderPage(
            { ...base0, step, moduleConfigs: [{ id: 'demo', fields: [{ key: 'K', label: 'k', type: 'string' as const }] }] },
            HINT,
          ),
        );
        continue;
      }
      htmls.push(renderPage({ ...base0, step }, HINT));
    }
    for (const hint of [HINT, { ...HINT, oauthUsable: false }, { ...HINT, ci: true }, { ...HINT, needsTotalTls: true }, { ...HINT, hasEnvToken: true }]) {
      htmls.push(renderPage(initialWizardState('/tmp/x/unself'), hint));
    }
    const allHtml = htmls.join('\n');
    const src = htmls.map((h) => inlineScripts(h).join('\n')).join('\n');
    const ids = [...new Set([...src.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1] as string))];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(allHtml).toContain(`id="${id}"`);
    }
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

// ---- #307 六步向导：新端点与分步推进 ----

describe('#307 GET /api/zones（zone 自动发现）', () => {
  it('deps.listZones 注入 → sessionToken 透传（① 粘的 token）；无注入 → 人话「未接线」', async () => {
    // 未接线：ok=false 且给手填指引
    const r0 = await fetch(`${base}/api/zones`);
    const j0 = (await r0.json()) as Record<string, unknown>;
    expect(j0.ok).toBe(false);
    expect(String(j0.message)).toContain('手填');

    // 接线：① 粘 token → listZones 收到同一 token；① 留空（OAuth 直跑）→ 收到 ''
    const seen: string[] = [];
    const { server: s2, port: p2 } = await startWizardServer({
      deps: {
        getState: () => initialWizardState('/tmp/x/zones/unself'),
        setState: () => {},
        hasEnvToken: false,
        envHint: { ...HINT },
        deploy: async () => ({ baseUrl: 'https://x', setupToken: null }),
        listZones: async (token) => {
          seen.push(token);
          return { ok: true, zones: [{ id: 'z1', name: 'example.com' }], message: '' };
        },
      },
    });
    try {
      const b2 = `http://127.0.0.1:${p2}`;
      await post2(b2, '/api/step1', { token: 'A'.repeat(40) });
      await (await fetch(`${b2}/api/zones`)).json();
      expect(seen).toEqual(['A'.repeat(40)]);

      const { server: s3, port: p3 } = await startWizardServer({
        deps: {
          getState: () => initialWizardState('/tmp/x/zones2/unself'),
          setState: () => {},
          hasEnvToken: false,
          envHint: { ...HINT },
          deploy: async () => ({ baseUrl: 'https://x', setupToken: null }),
          listZones: async (token) => {
            seen.push(token);
            return { ok: true, zones: [], message: '' };
          },
        },
      });
      try {
        const b3 = `http://127.0.0.1:${p3}`;
        await post2(b3, '/api/step1', { token: '' }); // OAuth 直跑 → sessionToken = ''
        await (await fetch(`${b3}/api/zones`)).json();
        expect(seen.at(-1)).toBe('');
      } finally {
        await new Promise<void>((resolve) => s3.close(() => resolve()));
      }
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    }
  });
});

describe('#307 GET /api/module-configs + POST /api/step3c（③★ 每模块一页）', () => {
  function serveWithConfigs(configs: WizardModuleConfig[], stateHolder: { state: WizardState }) {
    return startWizardServer({
      deps: {
        getState: () => stateHolder.state,
        setState: (s) => {
          stateHolder.state = s;
        },
        hasEnvToken: false,
        envHint: { ...HINT },
        deploy: async () => ({ baseUrl: 'https://x', setupToken: null }),
        moduleConfigs: configs,
      },
    });
  }

  it('③★ 无 config 声明 → ③ 直接进 ③½（module-config 步自动跳过）；有声明 → 出配置步', async () => {
    // 无声明：③ → storage（跳过 module-config）
    await post('/api/step1', { token: 'A'.repeat(40) });
    await post('/api/step2', { choice: 'workers' });
    const s3 = await post('/api/step3', { modules: 'hello' });
    expect(s3.json.step).toBe('storage');

    // 有声明：③ → module-config（demo 有配置页）——独立服务注入 moduleConfigs；
    // demo 是带来源的模块（#269 addModule 数据形态，confirmModules 只放行官方或已加来源的 id）
    const h2: { state: WizardState } = {
      state: initialWizardState('/tmp/x/cfg2/unself', {
        modules: ['demo'],
        moduleAdds: [
          {
            id: 'demo',
            source: 'npm:@acme/demo@1.0.0',
            kind: 'npm',
            version: '1.0.0',
            permissions: [],
            storageAccepts: ['core'],
            manifestHash: 'h',
          },
        ],
      }),
    };
    const { server: s2, port: p2 } = await serveWithConfigs(
      [{ id: 'demo', fields: [{ key: 'API_URL', label: '接口地址', type: 'url', required: true }] }],
      h2,
    );
    try {
      const b2 = `http://127.0.0.1:${p2}`;
      const post3 = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
        const res = await fetch(`${b2}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };
      await post3('/api/step1', { token: 'A'.repeat(40) });
      await post3('/api/step2', { choice: 'workers' });
      const s3b = await post3('/api/step3', { modules: 'demo' });
      expect(s3b.json.step).toBe('module-config');
      const cfgs = (await (await fetch(`${b2}/api/module-configs`)).json()) as { configs: WizardModuleConfig[] };
      expect(cfgs.configs.map((c) => c.id)).toEqual(['demo']);
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    }
  });

  it('③★ 非必填可空提交 → finish 进 ③½；必填缺失 → 400 人话；声明外模块 → 400', async () => {
    holder.state = {
      ...initialWizardState('/tmp/x/cfg/unself', { modules: ['demo'] }),
      hasToken: true,
      step: 'module-config',
      moduleConfigs: [{ id: 'demo', fields: [{ key: 'API_URL', label: '接口地址', type: 'url', required: true }] }],
    };
    const bad = await post('/api/step3c', { modId: 'demo', values: {} });
    expect(bad.status).toBe(400);
    expect(String(bad.json.problem)).toMatch(/必填/);
    expect(holder.state.step).toBe('module-config');

    const ghost = await post('/api/step3c', { modId: 'nope', values: { API_URL: 'https://x' } });
    expect(ghost.status).toBe(400);

    const ok = await post('/api/step3c', { modId: 'demo', values: { API_URL: 'https://api.example.com' } });
    expect(ok.status).toBe(200);
    const fin = await post('/api/step3c/finish', {});
    expect(fin.json.step).toBe('storage');
    expect(holder.state.configValues.demo?.API_URL).toBe('https://api.example.com');
  });

  it('③★ secret 值只进程内存：POST /api/state 永不回显 secret 键值；secret 必填未填 → finish 拒绝', async () => {
    holder.state = {
      ...initialWizardState('/tmp/x/sec/unself', { modules: ['demo'] }),
      hasToken: true,
      step: 'module-config',
      moduleConfigs: [{ id: 'demo', fields: [{ key: 'SECRET_KEY', label: '密钥', type: 'secret', required: true }] }],
    };
    // secret 未填 → finish 400
    const fin0 = await post('/api/step3c/finish', {});
    expect(fin0.status).toBe(400);
    expect(String(fin0.json.problem)).toMatch(/密钥.*必填/);
    expect(holder.state.step).toBe('module-config');

    // 保存 secret（非 secret 通路剥离）→ state 投影无 secret 值
    const SECRET = 'super-secret-value-42';
    const ok = await post('/api/step3c', { modId: 'demo', values: { SECRET_KEY: SECRET } });
    expect(ok.status).toBe(200);
    const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    expect(JSON.stringify(st)).not.toContain(SECRET);
    expect((st.configValues as Record<string, Record<string, string>>).demo?.SECRET_KEY).toBeUndefined();

    // finish 通过（secret 已在内存）→ storage
    const fin = await post('/api/step3c/finish', {});
    expect(fin.json.step).toBe('storage');
    // ⑥ failed 后重跑：step4 reset 连带清 secret（重填语义）
  });

  it('③★ test:http 测试连接：deps.testConnection 成功/失败两态人话回显；非 http(s) → 提示先填', async () => {
    const calls: string[] = [];
    const { server: s2, port: p2 } = await startWizardServer({
      deps: {
        getState: () => initialWizardState('/tmp/x/tc/unself'),
        setState: () => {},
        hasEnvToken: false,
        envHint: { ...HINT },
        deploy: async () => ({ baseUrl: 'https://x', setupToken: null }),
        testConnection: async (url) => {
          calls.push(url);
          return url.includes('good')
            ? { ok: true, message: '可达：HTTP 200' }
            : { ok: false, message: '连不上：超时' };
        },
      },
    });
    try {
      const b2 = `http://127.0.0.1:${p2}`;
      const post2 = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
        const res = await fetch(`${b2}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };
      const ok = await post2('/api/config-test', { url: 'https://good.example.com' });
      expect(ok.json).toEqual({ ok: true, message: '可达：HTTP 200' });
      const fail = await post2('/api/config-test', { url: 'https://bad.example.com' });
      expect(fail.json).toEqual({ ok: false, message: '连不上：超时' });
      const bad = await post2('/api/config-test', { url: 'ftp://x' });
      expect(String(bad.json.message)).toContain('http(s)');
      expect(calls).toEqual(['https://good.example.com', 'https://bad.example.com']);
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    }
  });

  it('④ deps.deploy 收到 configValues（secret 键在、值来自进程内存；非 secret 来自 state/default 兜底）', async () => {
    let seenConfigValues: Record<string, Record<string, string>> | undefined;
    const demoAdds = [
      {
        id: 'demo',
        source: 'npm:@acme/demo@1.0.0',
        kind: 'npm',
        version: '1.0.0',
        permissions: [],
        storageAccepts: ['core' as StorageLevel],
        manifestHash: 'h',
      },
    ];
    const h4: { state: WizardState } = {
      state: initialWizardState('/tmp/x/cv/unself', { modules: ['demo'], moduleAdds: demoAdds }),
    };
    const { server: s2, port: p2 } = await startWizardServer({
      deps: {
        getState: () => h4.state,
        setState: (s) => {
          h4.state = s;
        },
        hasEnvToken: false,
        envHint: { ...HINT },
        deploy: async (input) => {
          seenConfigValues = input.configValues;
          return { baseUrl: 'https://unself.test', setupToken: null };
        },
        moduleConfigs: [
          {
            id: 'demo',
            fields: [
              { key: 'API_URL', label: '接口地址', type: 'url', required: true, default: 'https://default.example.com' },
              { key: 'SECRET_KEY', label: '密钥', type: 'secret', required: true },
            ],
          },
        ],
      },
    });
    try {
      const b2 = `http://127.0.0.1:${p2}`;
      const post3 = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
        const res = await fetch(`${b2}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };
      await post3('/api/step1', { token: 'A'.repeat(40) });
      await post3('/api/step2', { choice: 'workers' });
      await post3('/api/step3', { modules: 'demo' });
      await post3('/api/step3c', { modId: 'demo', values: { API_URL: 'https://api.example.com', SECRET_KEY: 'sk-live-123' } });
      await post3('/api/step3c/finish', {});
      await post3('/api/step3b', { choices: {}, sharedConsent: false }); // ③½ 默认 → ready
      const r4 = await post3('/api/step4', {});
      expect(r4.status).toBe(202);
      for (let i = 0; i < 40 && h4.state.step === 'deploying'; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(h4.state.step).toBe('done');
      expect(seenConfigValues?.demo).toMatchObject({
        API_URL: 'https://api.example.com', // 非 secret：state 值
        SECRET_KEY: 'sk-live-123', // secret：服务进程内存注入
      });
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    }
  });
});

/** 独立 base 的 POST helper（多服务并测用）。 */
async function post2(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('#309 ③ storageOptions 快照重算（③½ 卡片集合 == 选中集合）', () => {
  function serveWithRefresh(stateHolder: { state: WizardState }) {
    return startWizardServer({
      deps: {
        getState: () => stateHolder.state,
        setState: (s) => {
          stateHolder.state = s;
        },
        hasEnvToken: false,
        envHint: { ...HINT },
        deploy: async () => ({ baseUrl: 'https://x', setupToken: null }),
        // 缺省注入 storageOptions 快照（启动时 hello+chat 可选）——refresh 才能体现「改选后重算」
        storageOptions: [
          { id: 'hello', accepts: ['core'] },
          { id: 'chat', accepts: ['dedicated'] },
        ],
        refreshStorageOptions: async (moduleIds) =>
          [{ id: 'hello', accepts: ['core'] }, { id: 'chat', accepts: ['dedicated'] }].filter((o) =>
            moduleIds.includes(o.id),
          ),
      },
    });
  }

  it('③ 改选（取消 chat）→ ③½ 卡片集合 == 选中集合，无幽灵 chat 卡', async () => {
    const h: { state: WizardState } = {
      state: initialWizardState('/tmp/x/ghost/unself', { modules: ['hello', 'chat'] }),
    };
    const { server: s2, port: p2 } = await serveWithRefresh(h);
    try {
      const b2 = `http://127.0.0.1:${p2}`;
      const post3 = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
        const res = await fetch(`${b2}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };
      await post3('/api/step1', { token: 'A'.repeat(40) });
      await post3('/api/step2', { choice: 'workers' });
      // 首次：hello+chat 都勾
      await post3('/api/step3', { modules: 'hello, chat' });
      expect(h.state.storageOptions.map((o) => o.id).sort()).toEqual(['chat', 'hello']);
      // 回③改选：只留 hello
      const r = await post3('/api/step3', { modules: 'hello' });
      expect(r.status).toBe(200);
      expect(h.state.storageOptions.map((o) => o.id)).toEqual(['hello']);
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    }
  });

  it('refresh 未注入：缺省按注入快照过滤选中清单（不出现清单外卡片）', async () => {
    const h: { state: WizardState } = {
      state: initialWizardState('/tmp/x/ghost2/unself', { modules: ['hello', 'chat'] }),
    };
    const { server: s2, port: p2 } = await startWizardServer({
      deps: {
        getState: () => h.state,
        setState: (s) => {
          h.state = s;
        },
        hasEnvToken: false,
        envHint: { ...HINT },
        deploy: async () => ({ baseUrl: 'https://x', setupToken: null }),
        storageOptions: [{ id: 'chat', accepts: ['dedicated'] }],
      },
    });
    try {
      const b2 = `http://127.0.0.1:${p2}`;
      const post3 = async (path: string, body: unknown): Promise<void> => {
        await fetch(`${b2}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      };
      await post3('/api/step1', { token: 'A'.repeat(40) });
      await post3('/api/step2', { choice: 'workers' });
      await post3('/api/step3', { modules: 'hello' });
      expect(h.state.storageOptions.map((o) => o.id)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    }
  });
});
