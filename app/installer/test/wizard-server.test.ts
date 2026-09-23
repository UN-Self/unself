// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web 向导 HTTP 壳行为测试（不依赖浏览器）：fetch 真 listen 冒烟 + 路由/状态机。
 * deps.deploy 注入替身（成功路径 / 抛错路径），事件经 GET /api/events 回读。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWizardServer, setCredentialSource, startWizardServer, viewStepOf } from '../src/web/server';
import { initialWizardState, type StorageLevel, type WizardEnvHint, type WizardModuleConfig, type WizardState, type WizardStorageOption } from '../src/web/state';

let holder: { state: WizardState };
let base: string;
let close: () => Promise<void>;
/** deploy 替身收到的调用参数（重跑保留凭证等行为断言用）。 */
let deployCalls: Array<Record<string, unknown>>;

/** ①步环境提示基线：OAuth 可用、非 CI、非多级子域（#246 envHint 缺省语义）。 */
const HINT: WizardEnvHint = { hasEnvToken: false, oauthUsable: true, needsTotalTls: false, ci: false };

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'unself-wizsrv-'));
  holder = { state: initialWizardState(join(root, 'demo', 'unself'), { modules: ['hello'] }) };
  deployCalls = [];
  const { server, port } = await startWizardServer({
    deps: {
      getState: () => holder.state,
      setState: (s) => {
        holder.state = s;
      },
      hasEnvToken: false,
      envHint: { ...HINT },
      deploy: async (input) => {
        deployCalls.push(input as unknown as Record<string, unknown>);
        input.onEvent('九步进度（替身）：步骤 1/9');
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

describe('GET /（页面：SPA 静态产物）', () => {
  it('返回构建出的 SPA HTML（text/html + no-store），入口挂载点在页', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('id="app"');
  });

  it('构建资产（JS/CSS）按正确 MIME 服务；未知路径 404 JSON', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const m = /src="(.+\.js)"/.exec(html);
    expect(m).not.toBeNull();
    const js = await fetch(`${base}${m![1]}`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const missing = await fetch(`${base}/assets/nope-${Date.now()}.js`);
    expect(missing.status).toBe(404);
    expect((await missing.json() as Record<string, unknown>).problem).toContain('未知路径');
  });

  it('/api/meta 下发 token 深链接（权限预选真源）+ 主题变量（值唯一真源 = 契约默认主题）', async () => {
    const meta = (await (await fetch(`${base}/api/meta`)).json()) as Record<string, unknown>;
    const link = String(meta.tokenDeepLink);
    expect(link).toContain('permissionGroupKeys=');
    expect(link).toContain(encodeURIComponent('workers_kv_storage'));
    expect(link).not.toContain(encodeURIComponent('"key":"workers_kv"'));
    const vars = String(meta.themeVars);
    expect(vars).toContain('--unself-color-primary:');
    expect(vars).toContain('--unself-duration-fast:');
    expect(vars).toContain('--unself-motion-press-scale:');
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

    // 等装配收敛到 done（替身睡 20ms；收尾身份在置 done 前写完，此处快照必含——#287）
    for (let i = 0; i < 40; i++) {
      const stPoll = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
      if (stPoll.step === 'done' || stPoll.step === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // 事件流回读（SSE）
    const es = await fetch(`${base}/api/events`);
    const text = await es.text();
    expect(text).toContain('步骤 1/9');

    // 收尾身份三项（#287）：SSE 里跟随「装配完成」出现；installer 版本可能未熔印（dev 树）→ 不硬编码，
    // 断言行为形状：unself 版本行 + commit（40 位 SHA 或 dev 占位）+ workbench 版本行。
    expect(text).toMatch(/unself 版本：v/);
    expect(text).toMatch(/commit [0-9a-f]{40}|commit dev\b/);
    expect(text).toMatch(/平台产物：@unself\/workbench v\d+\.\d+\.\d+|平台产物不可用/);

    // ⑤ 收尾：done + baseUrl + setup 深链 + **版本身份三项（#287）落 result**
    for (let i = 0; i < 40; i++) {
      const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
      if (st.step === 'done') {
        const result = st.result as Record<string, unknown>;
        expect(result.baseUrl).toBe('https://unself-workbench.test.workers.dev');
        expect(result.setupUrl).toContain('/setup?token=');
        // #287 验收：完成屏看得到的身份必须来自 result（日志会被完成屏取代——2026-09-23 走查实锤）。
        const identity = result.identity as string[];
        expect(Array.isArray(identity)).toBe(true);
        expect(identity.length).toBeGreaterThanOrEqual(2);
        expect(identity.join('\n')).toMatch(/unself 版本：v/);
        expect(identity.join('\n')).toMatch(/commit [0-9a-f]{40}|commit dev\b/);
        expect(identity.join('\n')).toMatch(/平台产物：@unself\/workbench v\d+\.\d+\.\d+|平台产物不可用/);
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
  it('deploy 抱 10000（KV 端点，token 路径）→ failed + 点名 KV 权限组 + 深链接重建（非 OAuth 文案）', async () => {
    const { server, port } = await startWizardServer({
      deps: {
        getState: () => holder.state,
        setState: (s) => {
          holder.state = s;
        },
        hasEnvToken: false,
        envHint: { ...HINT },
        deploy: async () => {
          throw new Error('CF API GET /accounts/acc123/storage/kv/namespaces 失败：10000 Authentication error');
        },
      },
    });
    const b3 = `http://127.0.0.1:${port}`;
    const post3 = async (path: string, body: unknown): Promise<void> => {
      const r = await fetch(`${b3}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(r.status).toBeLessThan(400);
    };
    try {
      // 同一实例内走完①②③（credentialSource 记 'token'——凭证来源是实例级闭包状态）
      await post3('/api/step1', { token: 'A'.repeat(40) });
      await post3('/api/step2', { choice: 'workers' });
      await post3('/api/step3', { modules: 'hello' });
      holder.state.step = 'ready';
      const r4 = await fetch(`${b3}/api/step4`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(r4.status).toBe(202);
      for (let i = 0; i < 40; i++) {
        const st = (await (await fetch(`${b3}/api/state`)).json()) as Record<string, unknown>;
        if (st.step === 'failed') {
          const err = st.error as Record<string, unknown>;
          expect(err.owner).toBe('token');
          expect(String(err.cause)).toContain('10000');
          expect(String(err.fix)).toContain('Workers KV Storage');
          expect(String(err.fix)).not.toContain('wrangler OAuth');
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

  it('重跑不清凭证：failed → step4 → 收敛全程不再回①（2026-09-22 走查实锤：重填 token 违背幂等收敛）', async () => {
    // 与上一测同一条链：①②③ ready → 人为 failed → step4 重跑；部署替身睡 20ms。
    // 重跑后 state 回 auth（reset 语义不变），但凭证保留：done 前不需要任何 POST /api/step1。
    await post('/api/step1', { token: 'A'.repeat(40) });
    await post('/api/step2', { choice: 'workers' });
    await post('/api/step3', { modules: 'hello' });
    holder.state.step = 'failed';
    holder.state.error = { cause: 'x', owner: 'code', fix: 'y' };

    const r = await post('/api/step4', {});
    expect(r.status).toBe(202);
    // 铁证：deploy 替身收到与①粘贴一致的 token（保留而非丢弃）。
    expect(deployCalls).toHaveLength(1);
    expect((deployCalls[0] as { token?: string }).token).toBe('A'.repeat(40));
    // 收敛回 done（未插入任何 step1 重验）。
    let final: Record<string, unknown> | null = null;
    for (let i = 0; i < 40; i++) {
      const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
      if (st.step === 'done' || st.step === 'failed') {
        final = st;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(final?.step).toBe('done');
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

describe('① 折叠入口与凭证面（SPA 行为：/api/meta + /api/state 投影）', () => {
  it('/api/state 投影 envHint（四布尔）且不含 token 明文；credentialSource 未过①为 null', async () => {
    const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    const hint = st.envHint as Record<string, unknown>;
    expect(hint).toMatchObject({ hasEnvToken: false, oauthUsable: true, needsTotalTls: false, ci: false });
    expect(st.credentialSource).toBeNull();
    expect(JSON.stringify(st)).not.toContain('token');
  });

  it('过了①（token 真验路径）→ credentialSource=token（SPA 据此分流②屏 zone 下拉）', async () => {
    setCredentialSource(null);
    await post('/api/step1', { token: 'A'.repeat(40) });
    const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    expect(st.credentialSource).toBe('token');
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

  it('② 选 custom 多级子域 → 之后 envHint.needsTotalTls=true（SPA 横幅/折叠展开依据）', async () => {
    await post('/api/step1', { token: 'A'.repeat(40) });
    const r2 = await post('/api/step2', { choice: 'custom', domain: 'a.team.example.com' });
    expect(r2.status).toBe(200);

    const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    expect((st.envHint as Record<string, unknown>).needsTotalTls).toBe(true);
  });

  it('② 选 custom 单级子域（zone 下一级）→ needsTotalTls 保持 false', async () => {
    await post('/api/step1', { token: 'A'.repeat(40) });
    const r2 = await post('/api/step2', { choice: 'custom', domain: 'team.example.com' });
    expect(r2.status).toBe(200);

    const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    expect((st.envHint as Record<string, unknown>).needsTotalTls).toBe(false);
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

describe('① 回退重提换 token（#309② 后续）：hasToken 后重提不再被吞', () => {
  const seen = { verify: [] as string[], zoneToken: '' };
  beforeEach(async () => {
    seen.verify = [];
    seen.zoneToken = '';
    const root = mkdtempSync(join(tmpdir(), 'unself-wizresub-'));
    holder = { state: initialWizardState(join(root, 'demo', 'unself'), { modules: ['hello'] }) };
    const { server, port } = await startWizardServer({
      deps: {
        getState: () => holder.state,
        setState: (s) => {
          holder.state = s;
        },
        hasEnvToken: false,
        envHint: { ...HINT },
        verifyToken: async (t) => {
          seen.verify.push(t);
          return { ok: true, message: '' };
        },
        listZones: async (t) => {
          seen.zoneToken = t;
          return { ok: true, zones: [], message: '' };
        },
        deploy: async () => ({ baseUrl: 'https://x', setupToken: null }),
      },
    });
    base = `http://127.0.0.1:${port}`;
    close = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    };
  });

  it('已过①再 POST step1 → 重新真验并覆盖 sessionToken（④/② 用的是新 token）', async () => {
    expect((await post('/api/step1', { token: 'A'.repeat(40) })).status).toBe(200);
    // 回退①后粘新 token 重新提交：不再 200 假成功，而是真验 + 覆盖
    const s2 = await post('/api/step1', { token: 'B'.repeat(40) });
    expect(s2.status).toBe(200);
    expect(s2.json.step).toBe('domain');
    expect(seen.verify).toEqual(['A'.repeat(40), 'B'.repeat(40)]);
    await fetch(`${base}/api/zones`);
    expect(seen.zoneToken).toBe('B'.repeat(40));
  });

  it('已过①重提无效 token → 400 真验失败原地不动，旧 sessionToken 不被破坏', async () => {
    expect((await post('/api/step1', { token: 'A'.repeat(40) })).status).toBe(200);
    const bad = await post('/api/step1', { token: 'bad!token' });
    expect(bad.status).toBe(400);
    expect(String(bad.json.problem)).toContain('以外的字符');
    expect(holder.state.step).toBe('domain');
    await fetch(`${base}/api/zones`);
    expect(seen.zoneToken).toBe('A'.repeat(40));
  });

  it('② 屏布局跟随凭证来源（数据面）：OAuth→oauth 投影；换粘 token→token 投影（SPA 据此分流）', async () => {
    const src = async (): Promise<unknown> => {
      const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
      return st.credentialSource;
    };
    // OAuth 直跳（此 holder 的 envHint oauthUsable=true，非 CI）
    expect((await post('/api/step1', { token: '' })).status).toBe(200);
    expect(await src()).toBe('oauth');
    // 回①换粘 token → 投影切 token（② 屏渲染出 zone 下拉的数据前提）
    expect((await post('/api/step1', { token: 'A'.repeat(40) })).status).toBe(200);
    expect(await src()).toBe('token');
    // 再换回 OAuth 直跳 → 手填布局前提
    expect((await post('/api/step1', { token: '' })).status).toBe(200);
    expect(await src()).toBe('oauth');
  });
});

describe('① 凭证屏改版（SPA 组件行为在组件测试覆盖；服务端契约在此）', () => {
  it('唯一提交端点 /api/step1：空值 + OAuth 可用 → 直跑进②（无独立 OAuth 按钮 API）', async () => {
    const r = await post('/api/step1', { token: '' });
    expect(r.status).toBe(200);
    expect(r.json.step).toBe('domain');
    expect(holder.state.hasToken).toBe(true);
  });

  it('OAuth 不可用 + 空值 → 400「token 为空」（唯一按钮路径的唯一空态拒绝）', async () => {
    const { server, port } = await startWizardServer({
      deps: {
        getState: () => holder.state,
        setState: (st) => {
          holder.state = st;
        },
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
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body.problem)).toContain('token 为空');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});


describe('SPA 产物服务契约（防「HTTP 200 但页面不可用」）', () => {
  it('GET / 的 HTML 引用的 CSS/JS 资产全部 200 且 MIME 正确（SPA 白屏防线）', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const refs = [...html.matchAll(/(?:src|href)="(\.?\/[^"]+\.(?:js|css))"/g)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const res = await fetch(`${base}${ref.startsWith('/') ? ref : `/${ref}`}`);
      expect(res.status).toBe(200);
      const type = res.headers.get('content-type') ?? '';
      expect(type === 'text/javascript; charset=utf-8' || type === 'text/css; charset=utf-8').toBe(true);
    }
  });

  it('构建产物里的应用模块不残留 HTML 字符串模板（pageScript 已死的回归防）', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const refs = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(0);
    const bodies = await Promise.all(refs.map((r) => fetch(`${base}${r}`).then((res) => res.text())));
    const all = bodies.join('\n');
    expect(all).not.toContain('form-auth');
    // 应用模块（非 polyfill）必须接 /api/state（状态链真源）
    expect(all).toContain('api/state');
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
        // 启动快照含「曾加过又取消的 legacy」——refresh 重算后必须消失（幽灵卡回归）
        storageOptions: [
          { id: 'hello', accepts: ['core'] },
          { id: 'chat', accepts: ['dedicated'] },
          { id: 'legacy', accepts: ['core'] },
        ],
        refreshStorageOptions: async (moduleIds): Promise<WizardStorageOption[]> =>
          (
            [
              // 模拟「真重算」与启动快照的漂移：hello 的声明在重算后变了（快照过期）
              { id: 'hello', accepts: ['dedicated'] as StorageLevel[] },
              { id: 'chat', accepts: ['dedicated'] as StorageLevel[] },
            ] as WizardStorageOption[]
          ).filter((o) => moduleIds.includes(o.id)),
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
      // 首次：hello+chat 都勾（refresh 重算生效：hello.accepts 来自重算而非过期快照）
      await post3('/api/step3', { modules: 'hello, chat' });
      expect(h.state.storageOptions.map((o) => o.id).sort()).toEqual(['chat', 'hello']);
      expect(h.state.storageOptions.find((o) => o.id === 'hello')?.accepts).toEqual(['dedicated']);
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

describe('#309 ①② zone 发现（SPA 分流依据 = /api/state.credentialSource）', () => {
  it('token 路径 → credentialSource=token（② 屏 zone 下拉的数据前提）；/api/zones 未接线回手填', async () => {
    setCredentialSource('token');
    const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    expect(st.credentialSource).toBe('token');
    const zones = (await (await fetch(`${base}/api/zones`)).json()) as Record<string, unknown>;
    expect(zones.ok).toBe(false);
    expect(String(zones.message)).toContain('手填');
    setCredentialSource(null);
  });

  it('OAuth 路径 → credentialSource=oauth（② 屏手填完整域名的数据前提）', async () => {
    setCredentialSource('oauth');
    const st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    expect(st.credentialSource).toBe('oauth');
    setCredentialSource(null);
  });

  it('重提另一凭证换来源 → 投影跟随（oauth→token）', async () => {
    setCredentialSource('oauth');
    let st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    expect(st.credentialSource).toBe('oauth');
    setCredentialSource('token');
    st = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
    expect(st.credentialSource).toBe('token');
    setCredentialSource(null);
  });
});


describe('#309 ② ?step= 渲染回退（守卫 = viewStepOf 纯函数；SPA 深链同语义）', () => {
  const at = (step: WizardState['step']): WizardState => ({
    ...initialWizardState('/tmp/x/back/unself', { modules: ['hello'] }),
    hasToken: true,
    step,
  });

  it('已完成步可达（storage → domain）；视图只换渲染不换状态', () => {
    const state = at('storage');
    const view = viewStepOf(state, 'domain');
    expect(view.step).toBe('domain');
    expect(state.step).toBe('storage');
  });

  it('未完成步不可达（auth 下 ?step=done → 仍 auth）；未知值落回当前步', () => {
    const state = at('auth');
    expect(viewStepOf(state, 'done').step).toBe('auth');
    expect(viewStepOf(state, 'nonsense').step).toBe('auth');
  });

  it('未完成中间步不可达：storage 步不能跳到未经历的 module-config（自动跳过不可达）', () => {
    expect(viewStepOf(at('storage'), 'module-config').step).toBe('storage');
  });

  it('同当前步/未来步 → 原样（推进权限只在 POST 端点）', () => {
    expect(viewStepOf(at('domain'), 'domain').step).toBe('domain');
    expect(viewStepOf(at('auth'), 'modules').step).toBe('auth');
  });

  it('GET /?step=… 服务端仍回 SPA 壳（视图切换在前端执行）', async () => {
    holder.state = at('storage');
    const res = await fetch(`${base}/?step=domain`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="app"');
    const st = (await (await fetch(`${base}/api/state`)).json()) as { step: string };
    expect(st.step).toBe('storage');
  });
});

describe('#309 ③½ accepts 单项 = 作者声明说明卡（数据面；渲染在组件测试）', () => {
  const baseState = (): WizardState => ({
    ...initialWizardState('/tmp/x/only/unself', {
      modules: ['hello', 'chat'],
      storageOptions: [
        { id: 'hello', accepts: ['core'], preferred: 'core' },
        { id: 'chat', accepts: ['dedicated'], preferred: 'dedicated' },
      ],
    }),
    hasToken: true,
    step: 'storage',
  });

  it('step3b 提交单项声明模块（无 radio 可选）：服务端 accepts 校验通过唯一 accepts', async () => {
    holder.state = baseState();
    const r = await post('/api/step3b', { choices: { hello: 'core', chat: 'dedicated' }, sharedConsent: false });
    expect(r.status).toBe(200);
    expect(r.json.step).toBe('ready');
    expect(holder.state.storageChoices).toMatchObject({ hello: 'core', chat: 'dedicated' });
  });

  it('选声明之外的落点 → 400（accepts 校验挡住）', async () => {
    holder.state = baseState();
    const r = await post('/api/step3b', { choices: { chat: 'shared' }, sharedConsent: false });
    expect(r.status).toBe(400);
    expect(holder.state.step).toBe('storage');
  });

  it('shared 选择需知情同意（consent=false → 400）', async () => {
    holder.state = { ...baseState(), storageOptions: [{ id: 'demo', accepts: ['core', 'shared'], preferred: 'core' }] };
    const r = await post('/api/step3b', { choices: { demo: 'shared' }, sharedConsent: false });
    expect(r.status).toBe(400);
    const r2 = await post('/api/step3b', { choices: { demo: 'shared' }, sharedConsent: true });
    expect(r2.status).toBe(200);
  });
});
