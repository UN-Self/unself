// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #269 安装器模块入口测试：向导③ 来源入口 / 权限门禁用户面 / 资源名重算 / token 真验接线 / 装配条目。
 *
 * 验收对照：
 * - ③ 粘来源 → 装配前展示 来源/版本/SRI/permissions/落点；未知能力点名拒绝；
 * - ③ 改模块后资源名预览重算（previewResources 被以新 id 调用）；
 * - ④ 把 {id, source} 条目 + yes 传给部署；
 * - ① token 形状放宽（#269）+ verifyToken 真验：无效 token 显示 CF 原话，网络/权限问题分开报。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWizardServer, type WizardDeps } from '../src/web/server';
import {
  addModule,
  deployModules,
  initialWizardState,
  resetWizard,
  tokenProblem,
  type WizardEnvHint,
  type WizardModuleAdd,
  type WizardState,
} from '../src/web/state';
import { addModuleToConfigText, readModulesArray } from '../src/lib/config-edit';

const HINT: WizardEnvHint = { hasEnvToken: false, oauthUsable: true, needsTotalTls: false, ci: false };
const TOKEN = `1${'a'.repeat(39)}`; // 老格式：40 位字母数字，首字符是数字（#269 不再拦）

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unself-269-mod-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const PREVIEW: WizardModuleAdd = {
  id: 'todo',
  source: 'npm:@acme/unself-todo@1.2.0',
  kind: 'npm',
  version: '1.2.0',
  integrity: 'sha512-AAAABBBBCCCCDDDDEEEEFFFF',
  permissions: ['storage', 'notify'],
  storageAccepts: ['shared', 'core'],
  storagePreferred: 'shared',
  manifestHash: 'a'.repeat(64),
};

/** 起一个向导服务（deps 可覆盖），返回 base URL 与 post 助手。 */
async function serve(deps: Partial<WizardDeps> & Pick<WizardDeps, 'getState' | 'setState'>): Promise<{
  base: string;
  post: (path: string, body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
  get: (path: string) => Promise<{ status: number; text: string }>;
  close: () => void;
}> {
  const full: WizardDeps = {
    hasEnvToken: false,
    envHint: { ...HINT },
    deploy: async () => ({ baseUrl: 'https://demo-core-api.workers.dev', setupToken: null }),
    ...deps,
  };
  const server = createWizardServer({ deps: full });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    post: async (path, body) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
    get: async (path) => {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, text: await res.text() };
    },
    close: () => server.close(),
  };
}

describe('#269 ③ 来源入口（向导）', () => {
  it('粘安装串 → 展示 来源/版本/SRI/permissions/落点，并重算资源名', async () => {
    const holder: { state: WizardState } = {
      state: initialWizardState(join(root, 'demo', 'unself'), {
        modules: ['hello'],
        resourceNames: [{ kind: 'Worker', name: 'demo-core-api' }],
      }),
    };
    const previewCalls: string[][] = [];
    const srv = await serve({
      getState: () => holder.state,
      setState: (s) => {
        holder.state = s;
      },
      resolveModule: async (source) => ({ ...PREVIEW, source }),
      previewResources: async (ids) => {
        previewCalls.push([...ids]);
        return [{ kind: 'Worker', name: `demo-${ids.join('-')}` }];
      },
    });
    try {
      expect((await srv.post('/api/step1', { token: TOKEN })).status).toBe(200);
      const added = await srv.post('/api/step3/add', { source: PREVIEW.source });
      expect(added.status).toBe(200);
      expect(added.json.id).toBe('todo');

      // 状态：模块并入 + 落点单选可渲染 + 资源名重算（③ 改模块后不再沿用启动快照）
      expect(holder.state.moduleAdds.map((m) => m.id)).toEqual(['todo']);
      expect(holder.state.storageOptions.find((o) => o.id === 'todo')?.accepts).toEqual(['shared', 'core']);
      expect(previewCalls.at(-1)).toEqual(['hello', 'todo']);
      expect(holder.state.resourceNames).toEqual([{ kind: 'Worker', name: 'demo-hello-todo' }]);

      // 投影：装配前「将要装什么」可读（#307 分屏：预览在③模块屏；SPA 渲染面在组件测试覆盖）
      holder.state = { ...holder.state, step: 'modules' };
      const page = await srv.get('/');
      expect(page.status).toBe(200);
      const st = JSON.parse((await srv.get('/api/state')).text) as {
        moduleAdds: Array<Record<string, unknown>>;
      };
      expect(st.moduleAdds).toHaveLength(1);
      expect(st.moduleAdds[0]).toMatchObject({
        id: 'todo',
        source: 'npm:@acme/unself-todo@1.2.0',
        version: '1.2.0',
        integrity: 'sha512-AAAABBBBCCCCDDDDEEEEFFFF',
      });
      expect(st.moduleAdds[0]!.permissions).toEqual(['storage', 'notify']);
      expect(st.moduleAdds[0]!.storageAccepts).toEqual(['shared', 'core']);
    } finally {
      srv.close();
    }
  });

  it('未知能力：resolveModule 抛错 → 400 且点名能力（用户面拒绝）', async () => {
    const holder: { state: WizardState } = {
      state: initialWizardState(join(root, 'demo', 'unself'), { modules: ['hello'] }),
    };
    const srv = await serve({
      getState: () => holder.state,
      setState: (s) => {
        holder.state = s;
      },
      resolveModule: async () => {
        throw new Error(
          '模块包声明了未知能力「telepathy」：安装时拒绝（决策 #56 / docs/modules.md L73）。当前词表：storage / acl / notify / ai / realtime / mail；未知能力被静默忽略会导致模块运行期莫名 403，故安装期硬拒。',
        );
      },
    });
    try {
      await srv.post('/api/step1', { token: TOKEN });
      const r = await srv.post('/api/step3/add', { source: 'npm:@acme/evil@1.0.0' });
      expect(r.status).toBe(400);
      expect(String(r.json.problem)).toContain('telepathy');
      expect(String(r.json.problem)).toContain('安装时拒绝');
      // 状态未被污染
      expect(holder.state.moduleAdds).toHaveLength(0);
    } finally {
      srv.close();
    }
  });

  it('重复添加同一模块 → 400（不静默覆盖）', async () => {
    const holder: { state: WizardState } = {
      state: initialWizardState(join(root, 'demo', 'unself'), { modules: ['hello'] }),
    };
    const srv = await serve({
      getState: () => holder.state,
      setState: (s) => {
        holder.state = s;
      },
      resolveModule: async (source) => ({ ...PREVIEW, source }),
    });
    try {
      await srv.post('/api/step1', { token: TOKEN });
      expect((await srv.post('/api/step3/add', { source: PREVIEW.source })).status).toBe(200);
      const dup = await srv.post('/api/step3/add', { source: PREVIEW.source });
      expect(dup.status).toBe(400);
      expect(String(dup.json.problem)).toContain('已在本次装配清单');
    } finally {
      srv.close();
    }
  });

  it('④ 把 {id, source} 条目 + yes 传给部署（来源真进装配输入）', async () => {
    const holder: { state: WizardState } = {
      state: initialWizardState(join(root, 'demo', 'unself'), { modules: ['hello'] }),
    };
    const captures: Array<Record<string, unknown>> = [];
    const srv = await serve({
      getState: () => holder.state,
      setState: (s) => {
        holder.state = s;
      },
      resolveModule: async (source) => ({ ...PREVIEW, source }),
      deploy: async (input) => {
        captures.push(input as unknown as Record<string, unknown>);
        return { baseUrl: 'https://demo-core-api.workers.dev', setupToken: null };
      },
    });
    try {
      await srv.post('/api/step1', { token: TOKEN });
      await srv.post('/api/step3/add', { source: PREVIEW.source });
      await srv.post('/api/step3', { modules: 'hello,todo' });
      await srv.post('/api/step3b', { choices: {}, sharedConsent: true });
      const start = await srv.post('/api/step4', {});
      expect(start.status).toBe(202);
      for (let i = 0; i < 50 && captures.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(captures).toHaveLength(1);
      expect(captures[0]!.modules).toEqual([
        { id: 'hello', source: 'npm:@unself/hello@0.1.0' },
        { id: 'todo', source: PREVIEW.source },
      ]);
      expect(captures[0]!.yes).toBe(true);
    } finally {
      srv.close();
    }
  });
});

describe('#269 ① token 形状放宽 + 真验接线', () => {
  it('形状只拦明显不对：CF 风格老/新格式都放行', () => {
    expect(tokenProblem('1'.repeat(40))).toBeNull(); // 老格式数字开头
    expect(tokenProblem(`cfut_${'a'.repeat(40)}${'b'.repeat(8)}`)).toBeNull(); // 新格式超 50 位
    expect(tokenProblem('short')).toBeNull(); // 短 token 也交给 CF 真验
    expect(tokenProblem('has space')).toMatch(/空格/);
    expect(tokenProblem('bad!char')).toMatch(/以外的字符/);
  });

  it('verifyToken 判无效 → 400 + CF 原话（且 token 不进状态）', async () => {
    const holder: { state: WizardState } = {
      state: initialWizardState(join(root, 'demo', 'unself'), { modules: ['hello'] }),
    };
    const seen: string[] = [];
    const srv = await serve({
      getState: () => holder.state,
      setState: (s) => {
        holder.state = s;
      },
      verifyToken: async (t) => {
        seen.push(t);
        return { ok: false, message: 'Cloudflare 判定 token 无效：1000 Invalid API Token' };
      },
    });
    try {
      const r = await srv.post('/api/step1', { token: TOKEN });
      expect(r.status).toBe(400);
      expect(String(r.json.problem)).toContain('Invalid API Token');
      // 真验确实收到了被放宽放行的 token
      expect(seen).toEqual([TOKEN]);
      expect(holder.state.step).toBe('auth');
      expect(JSON.stringify(holder.state)).not.toContain(TOKEN);
    } finally {
      srv.close();
    }
  });

  it('网络/权限问题与「token 无效」分开报', async () => {
    const holder: { state: WizardState } = {
      state: initialWizardState(join(root, 'demo', 'unself'), { modules: ['hello'] }),
    };
    const srv = await serve({
      getState: () => holder.state,
      setState: (s) => {
        holder.state = s;
      },
      verifyToken: async () => ({ ok: false, message: '连不上 Cloudflare，token 没能校验（网络问题，不是 token 无效）：fetch failed' }),
    });
    try {
      const r = await srv.post('/api/step1', { token: TOKEN });
      expect(r.status).toBe(400);
      expect(String(r.json.problem)).toContain('不是 token 无效');
      expect(holder.state.step).toBe('auth');
    } finally {
      srv.close();
    }
  });

  it('verifyToken 通过 → 进 ②，且 ④ 部署拿到同一个 token', async () => {
    const holder: { state: WizardState } = {
      state: initialWizardState(join(root, 'demo', 'unself'), { modules: ['hello'] }),
    };
    const captures: Array<Record<string, unknown>> = [];
    const srv = await serve({
      getState: () => holder.state,
      setState: (s) => {
        holder.state = s;
      },
      verifyToken: async () => ({ ok: true, message: 'Cloudflare 校验通过（token 状态：active）' }),
      deploy: async (input) => {
        captures.push(input as unknown as Record<string, unknown>);
        return { baseUrl: 'https://demo-core-api.workers.dev', setupToken: null };
      },
    });
    try {
      expect((await srv.post('/api/step1', { token: TOKEN })).status).toBe(200);
      expect(holder.state.step).toBe('domain');
      await srv.post('/api/step2', { choice: 'workers' });
      await srv.post('/api/step3', { modules: 'hello' });
      await srv.post('/api/step3b', { choices: {}, sharedConsent: false });
      await srv.post('/api/step4', {});
      for (let i = 0; i < 50 && captures.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(captures[0]!.token).toBe(TOKEN);
    } finally {
      srv.close();
    }
  });
});

describe('#269 状态机纯函数', () => {
  it('addModule 并入 modules/storageOptions/moduleAdds；重复 id 报 problem', () => {
    const s = initialWizardState(join(root, 'demo', 'unself'), { modules: ['hello'] });
    const r = addModule(s, { ...PREVIEW, storageAccepts: [...PREVIEW.storageAccepts] });
    expect(r.problem).toBeNull();
    expect(r.state.modules).toEqual(['hello', 'todo']);
    expect(r.state.storageOptions).toEqual([{ id: 'todo', accepts: ['shared', 'core'], preferred: 'shared' }]);
    const again = addModule(r.state, { ...PREVIEW, storageAccepts: [...PREVIEW.storageAccepts] });
    expect(again.problem).toMatch(/已在本次装配清单/);
    expect(again.state).toBe(r.state);
  });

  it('resetWizard（⑥ 幂等重跑）保留已添加模块', () => {
    const s = initialWizardState(join(root, 'demo', 'unself'), { modules: ['hello'] });
    const added = addModule(s, { ...PREVIEW, storageAccepts: [...PREVIEW.storageAccepts] }).state;
    const reset = resetWizard(added);
    expect(reset.step).toBe('ready');
    expect(reset.moduleAdds).toHaveLength(1);
    expect(reset.storageOptions.find((o) => o.id === 'todo')).toBeDefined();
  });

  it('deployModules：只保留仍在 modules 里的条目，来源条目带 source', () => {
    const s = initialWizardState(join(root, 'demo', 'unself'), { modules: ['hello'] });
    const added = addModule(s, { ...PREVIEW, storageAccepts: [...PREVIEW.storageAccepts] }).state;
    // #77：一律对象条目（官方模块写 npm 串，来源模块写原串）
    expect(deployModules(added)).toEqual([
      { id: 'hello', source: 'npm:@unself/hello@0.1.0' },
      { id: 'todo', source: PREVIEW.source },
    ]);
    expect(deployModules({ ...added, modules: ['hello'] })).toEqual([{ id: 'hello', source: 'npm:@unself/hello@0.1.0' }]);
  });
});

describe('#269 config-edit（modules 段安全编辑）', () => {
  const TEMPLATE = `// SPDX-License-Identifier: AGPL-3.0-only
{
  // 选中启用的模块
  "modules": [{"id":"hello","source":"npm:@unself/hello@0.1.0"}],
  "storage": { "provider": "r2" }
}
`;

  it('追加来源条目（全对象形态），其余原文（含注释）逐字节保留', () => {
    const next = addModuleToConfigText(TEMPLATE, { id: 'todo', source: 'npm:@acme/unself-todo@1.2.0' });
    expect(next).toContain('// 选中启用的模块');
    expect(next).toContain('// SPDX-License-Identifier: AGPL-3.0-only');
    expect(next).toContain(
      '"modules": [{"id":"hello","source":"npm:@unself/hello@0.1.0"}, {"id":"todo","source":"npm:@acme/unself-todo@1.2.0"}]',
    );
    expect(readModulesArray(next)).toEqual([
      { id: 'hello', source: 'npm:@unself/hello@0.1.0' },
      { id: 'todo', source: 'npm:@acme/unself-todo@1.2.0' },
    ]);
    // 非 modules 段不动
    expect(next).toContain('"storage": { "provider": "r2" }');
  });

  it('条目一律对象（#77 无裸字符串）；重复 id 拒绝（不猜不覆盖）', () => {
    const next = addModuleToConfigText(TEMPLATE, { id: 'notes', source: 'npm:@acme/notes@0.1.0' });
    expect(readModulesArray(next)).toEqual([
      { id: 'hello', source: 'npm:@unself/hello@0.1.0' },
      { id: 'notes', source: 'npm:@acme/notes@0.1.0' },
    ]);
    expect(() => addModuleToConfigText(next, { id: 'notes', source: 'npm:@acme/notes@0.2.0' })).toThrowError(/已在 unself.config.jsonc/);
  });

  it('已有多行/带注释的 modules 段可读（编辑后归一为单行）', () => {
    const multi = `{
  "modules": [
    {"id":"hello","source":"npm:@unself/hello@0.1.0"}, // 演示模块
    {"id":"todo","source":"file:./app/modules/todo"}
  ]
}
`;
    expect(readModulesArray(multi)).toEqual([
      { id: 'hello', source: 'npm:@unself/hello@0.1.0' },
      { id: 'todo', source: 'file:./app/modules/todo' },
    ]);
    const next = addModuleToConfigText(multi, { id: 'notes', source: 'npm:@acme/notes@0.1.0' });
    expect(readModulesArray(next)).toEqual([
      { id: 'hello', source: 'npm:@unself/hello@0.1.0' },
      { id: 'todo', source: 'file:./app/modules/todo' },
      { id: 'notes', source: 'npm:@acme/notes@0.1.0' },
    ]);
  });
});
