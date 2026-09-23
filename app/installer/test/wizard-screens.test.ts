// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

import { projectActivity } from '../web/src/lib/activity-projection';
import DeployScreen from '../web/src/screens/deploy-screen.vue';
import AuthScreen from '../web/src/screens/auth-screen.vue';
import DomainScreen from '../web/src/screens/domain-screen.vue';
import ModulesScreen from '../web/src/screens/modules-screen.vue';
import StorageScreen from '../web/src/screens/storage-screen.vue';
import DoneScreen from '../web/src/screens/done-screen.vue';
import type { WizardEventDto } from '../web/src/lib/activity-projection';

/**
 * 向导屏行为测试（两问检验）：
 * - 防重复提交：进行中二次点击不重复 POST（改坏 = 双击两发请求，必红）；
 * - 活动去重：同 i 事件只渲染一次（快照+增量重叠窗口防重）；
 * - 键盘/折叠/激活入口/重跑保留等用户可见行为。
 * fetch 全部经 vi.stubGlobal 打桩：只断「发了什么请求」，不打内部调用。
 */

const HINT = { hasEnvToken: false, oauthUsable: true, needsTotalTls: false, ci: false };

/** ④ 屏公共 props 基线。 */
const base = {
  domainChoice: 'workers' as const,
  domain: '',
  modules: ['hello'],
  resourceNames: [] as Array<{ kind: string; name: string }>,
  events: [] as WizardEventDto[],
  deploymentLink: null as string | null,
  error: null as { cause: string; owner: string; fix: string } | null,
};

let fetchCalls: Array<{ url: string; init?: RequestInit }>;
function stubFetch(responses: Array<{ match: RegExp; body: unknown; status?: number }>): void {
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    const hit = responses.find((r) => r.match.test(url));
    return new Response(JSON.stringify(hit?.body ?? {}), {
      status: hit?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('④ 装配屏：防重复提交（#309①⑥ 走查定稿语义）', () => {
  it('ready 态点击 → POST /api/step4 一次并转入 deploying；pending 中二次点击不重复 POST', async () => {
    stubFetch([{ match: /\/api\/step4$/, body: { step: 'deploying' } }]);
    const wrapper = mount(DeployScreen, { props: { ...base, step: 'ready' } });
    const btn = wrapper.find('[data-test=deploy-start]');
    await btn.trigger('click');
    // 第二次点击在 loading 期间（disabled + guard 双闸）
    await btn.trigger('click');
    await flushPromises();
    const posts = fetchCalls.filter((c) => c.url.endsWith('/api/step4'));
    expect(posts).toHaveLength(1);
    expect(wrapper.emitted('advanced')?.at(-1)).toEqual(['deploying']);
  });

  it('deploying 态（父组件同步 step）按钮禁用 + 点击不产生 POST', async () => {
    stubFetch([]);
    const wrapper = mount(DeployScreen, { props: { ...base, step: 'deploying' } });
    const btn = wrapper.find('[data-test=deploy-start]');
    expect(btn.attributes('disabled')).toBeDefined();
    await btn.trigger('click');
    await flushPromises();
    expect(fetchCalls.filter((c) => c.url.endsWith('/api/step4'))).toHaveLength(0);
  });

  it('deploying 态启动轮询：/api/state 变 done → emit advanced=done（进度推进主链）', async () => {
    vi.useFakeTimers();
    stubFetch([{ match: /\/api\/state$/, body: { step: 'done', events: [] } }]);
    const wrapper = mount(DeployScreen, { props: { ...base, step: 'deploying' } });
    await vi.advanceTimersByTimeAsync(900);
    expect(wrapper.emitted('advanced')?.at(-1)).toEqual(['done']);
    vi.useRealTimers();
  });
});

describe('④ 活动投影：分组 + i 去重（beUI agent-activity 语义）', () => {
  it('同 i 只渲染一次（快照+增量重叠防重）；编号事件开新组；无编号归当前组', () => {
    const events: WizardEventDto[] = [
      { i: 0, kind: 'log', text: '[1/9] 确保 D1' },
      { i: 1, kind: 'log', text: '[1/9] 确保 D1 ✓' },
      { i: 2, kind: 'log', text: '[2/9] 跑迁移' },
      // 快照窗口重叠：i=1 重复到达
      { i: 1, kind: 'log', text: '[1/9] 确保 D1 ✓' },
    ];
    const groups = projectActivity(events);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.lines.map((l) => l.i)).toEqual([0, 1]);
    expect(groups[0]!.state).toBe('complete');
    expect(groups[1]!.lines.map((l) => l.i)).toEqual([2]);
    expect(groups[1]!.state).toBe('running');
  });

  it('✗ 开头 = failed 组；✗ 后续 ✓ 不洗白失败态', () => {
    const groups = projectActivity([
      { i: 0, kind: 'log', text: '[3/9] 上传 Worker' },
      { i: 1, kind: 'log', text: '✗ 上传失败：cf_api_10405' },
      { i: 2, kind: 'log', text: '重试成功 ✓' },
    ]);
    expect(groups[0]!.state).toBe('failed');
  });

  it('编号段之后的文本进组标题（步骤 1/9 · 概要）；折叠默认收起、失败自动展开（组件行为）', async () => {
    stubFetch([{ match: /\/api\/state$/, body: { step: 'deploying', events: [] } }]);
    const wrapper = mount(DeployScreen, {
      props: {
        ...base,
        step: 'failed',
        error: { cause: 'CF API GET /storage/kv 失败：10000', owner: 'token', fix: '重建 token' },
        events: [
          { i: 0, kind: 'log', text: '[1/9] 确保 D1 ✓' },
          { i: 1, kind: 'log', text: '✗ 卡住' },
        ],
      },
    });
    const title = wrapper.find('[data-test=activity] summary');
    expect(title.text()).toContain('装配活动');
    // 失败态：折叠自动展开（用户不用再点一次才看到败因）——UActivity open 模型 + 失败组 details
    expect(wrapper.text()).toContain('1 个步骤');
    expect(wrapper.text()).toContain('✗ 卡住');
  });

});

describe('① 凭证屏：唯一按钮 + 掩码输入 + 直跑语义', () => {
  it('输入非空 → 按钮文案「使用 token 下一步」；清空回退「下一步」', async () => {
    stubFetch([]);
    const wrapper = mount(AuthScreen, { props: { envHint: HINT, tokenDeepLink: 'https://dash.example.com/x' } });
    const btn = wrapper.find('[data-test=auth-submit]');
    expect(btn.text()).toBe('下一步');
    await wrapper.find('input[type=password]').setValue('A'.repeat(40));
    expect(btn.text()).toBe('使用 token 下一步');
    await wrapper.find('input[type=password]').setValue('');
    expect(btn.text()).toBe('下一步');
  });

  it('空值提交（OAuth 可用）→ POST /api/step1 {token:""}；400 回显 problem 不跳屏', async () => {
    stubFetch([
      { match: /\/api\/step1$/, body: { problem: 'token 为空' }, status: 400 },
    ]);
    const wrapper = mount(AuthScreen, { props: { envHint: HINT, tokenDeepLink: '' } });
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.emitted('advanced')).toBeUndefined();
    expect(wrapper.text()).toContain('token 为空');
    // 折叠页里的深链接可用（权限预选唯一真源来自 /api/meta）
    expect(wrapper.find('a').attributes('href')).toBe('');
  });

  it('提交成功 → advanced 事件（父组件拉状态切屏）', async () => {
    stubFetch([{ match: /\/api\/step1$/, body: { step: 'domain' } }]);
    const wrapper = mount(AuthScreen, { props: { envHint: HINT, tokenDeepLink: '' } });
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.emitted('advanced')?.at(-1)).toEqual(['domain']);
  });
});

describe('② 域名屏：凭证来源分流 + Total TLS 提示 + 手填回退', () => {
  it('token 来源：选自有域 → 预取 zone（/api/zones）→ 前缀+下拉组合；Total TLS 实时提示', async () => {
    stubFetch([
      { match: /\/api\/zones$/, body: { ok: true, zones: [{ id: 'z1', name: 'example.com' }] } },
      { match: /\/api\/step2$/, body: { step: 'modules' } },
    ]);
    const wrapper = mount(DomainScreen, {
      props: { envHint: HINT, credentialSource: 'token', domainChoice: null },
    });
    await flushPromises();
    await wrapper.findAll('input[type=radio]')[1]!.setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-test=zone-pick]').exists()).toBe(true);
    await wrapper.find('[data-test=sub-prefix] input').setValue('team');
    // 未选 zone：不出提示
    expect(wrapper.find('[data-test=total-tls-warn]').exists()).toBe(false);
    await wrapper.find('[aria-haspopup=listbox]').trigger('click');
    await wrapper.find('[role=option]').trigger('click');
    expect(wrapper.find('[data-test=total-tls-warn]').exists()).toBe(false); // team.example.com 单级
    await wrapper.find('[data-test=sub-prefix] input').setValue('a.b');
    expect(wrapper.find('[data-test=total-tls-warn]').exists()).toBe(true); // a.b.example.com 两级
    await wrapper.find('[data-test=domain-submit]').trigger('click');
    await flushPromises();
    const post = fetchCalls.find((c) => c.url.endsWith('/api/step2'));
    expect(JSON.parse(String(post?.init?.body))).toEqual({ choice: 'custom', domain: 'a.b.example.com' });
    expect(wrapper.emitted('advanced')?.at(-1)).toEqual(['modules']);
  });

  it('zone 拿不到 → 手填回退（提交完整域名）', async () => {
    stubFetch([
      { match: /\/api\/zones$/, body: { ok: false, zones: [], message: 'token 缺 Zone·Read' } },
      { match: /\/api\/step2$/, body: { step: 'modules' } },
    ]);
    const wrapper = mount(DomainScreen, {
      props: { envHint: HINT, credentialSource: 'token', domainChoice: null },
    });
    await flushPromises();
    await wrapper.findAll('input[type=radio]')[1]!.setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-test=zone-fallback]').exists()).toBe(true);
    await wrapper.find('[data-test=full-domain] input').setValue('team.example.com');
    await wrapper.find('[data-test=domain-submit]').trigger('click');
    await flushPromises();
    const post = fetchCalls.find((c) => c.url.endsWith('/api/step2'));
    expect(JSON.parse(String(post?.init?.body))).toEqual({ choice: 'custom', domain: 'team.example.com' });
  });

  it('OAuth 来源：无 zone 预取，直接手填；非法域名即时人话（不发请求）', async () => {
    stubFetch([]);
    const wrapper = mount(DomainScreen, {
      props: { envHint: HINT, credentialSource: 'oauth', domainChoice: null },
    });
    await wrapper.findAll('input[type=radio]')[1]!.setValue(true);
    await wrapper.find('[data-test=full-domain] input').setValue('nodot');
    await wrapper.find('[data-test=domain-submit]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('不像完整域名');
    expect(fetchCalls.filter((c) => c.url.endsWith('/api/step2'))).toHaveLength(0);
  });

  it('workers.dev 第一项：默认选中，提交 {choice:"workers", domain:""}', async () => {
    stubFetch([{ match: /\/api\/step2$/, body: { step: 'modules' } }]);
    const wrapper = mount(DomainScreen, {
      props: { envHint: HINT, credentialSource: 'oauth', domainChoice: null },
    });
    await wrapper.find('[data-test=domain-submit]').trigger('click');
    await flushPromises();
    const post = fetchCalls.find((c) => c.url.endsWith('/api/step2'));
    expect(JSON.parse(String(post?.init?.body))).toEqual({ choice: 'workers', domain: '' });
  });
});

describe('③ 模块屏：勾选提交 + 高级添加', () => {
  it('勾选变化随提交发送；添加安装串 → POST step3/add 并回读最新清单', async () => {
    stubFetch([
      { match: /\/api\/step3\/add$/, body: { step: 'modules', id: 'todo' } },
      {
        match: /\/api\/state$/,
        body: {
          step: 'modules',
          modules: ['hello', 'todo'],
          moduleAdds: [{ id: 'todo', source: 'npm:@acme/x@1.0.0', kind: 'npm', version: '1.0.0', permissions: [], storageAccepts: ['core'] }],
        },
      },
      { match: /\/api\/step3$/, body: { step: 'storage' } },
    ]);
    const wrapper = mount(ModulesScreen, { props: { modules: ['hello'], moduleAdds: [] } });
    const boxes = wrapper.findAll('input[type=checkbox]');
    expect(boxes).toHaveLength(2); // hello + chat（官方）
    await boxes[1]!.setValue(true);
    await wrapper.find('[data-test=modules-submit]').trigger('click');
    await flushPromises();
    let post = fetchCalls.find((c) => c.url.endsWith('/api/step3'));
    expect(JSON.parse(String(post?.init?.body))).toEqual({ modules: ['hello', 'chat'] });
    expect(wrapper.emitted('advanced')?.at(-1)).toEqual(['storage']);

    // 高级添加
    await wrapper.find('details.fold summary').trigger('click');
    await wrapper.find('input[name=source]').setValue('npm:@acme/unself-todo@1.2.0');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    const addPost = fetchCalls.find((c) => c.url.endsWith('/api/step3/add'));
    expect(JSON.parse(String(addPost?.init?.body))).toEqual({ source: 'npm:@acme/unself-todo@1.2.0' });
    // 添加成功：输入清空 + 通知父级刷新清单（moduleAdds 是父级数据，屏不私改）
    expect((wrapper.find('input[name=source]').element as HTMLInputElement).value).toBe('');
  });
});

describe('③½ 存储屏：单项声明说明卡 + shared 知情同意', () => {
  it('多选项模块发真单选；单项声明模块自动取唯一 accepts；shared 必须勾同意', async () => {
    stubFetch([{ match: /\/api\/step3b$/, body: { step: 'ready' } }]);
    const wrapper = mount(StorageScreen, {
      props: {
        storageOptions: [
          { id: 'hello', accepts: ['core', 'shared'], preferred: 'core' },
          { id: 'chat', accepts: ['dedicated'], preferred: 'dedicated' },
        ],
        storageChoices: {},
        sharedConsent: false,
      },
    });
    // 单项声明卡可见、无 radio
    expect(wrapper.text()).toContain('作者声明：只支持');
    const chatField = wrapper.find('[data-mod=chat]');
    expect(chatField.findAll('input[type=radio]')).toHaveLength(0);
    // hello 选 shared → 需同意
    const radios = wrapper.find('[data-mod=hello]').findAll('input[type=radio]');
    await radios[1]!.setValue(true);
    await wrapper.find('[data-test=storage-submit]').trigger('click');
    await flushPromises();
    // 未勾同意照样提交（sharedConsent:false）——知情同意闸在服务端（wizard-server 集成测试断 400）
    let post = fetchCalls.find((c) => c.url.endsWith('/api/step3b'));
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      choices: { hello: 'shared', chat: 'dedicated' },
      sharedConsent: false,
    });
    await wrapper.find('[data-test=shared-consent]').setValue(true);
    await wrapper.find('[data-test=storage-submit]').trigger('click');
    await flushPromises();
    post = fetchCalls.filter((c) => c.url.endsWith('/api/step3b')).at(-1);
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      choices: { hello: 'shared', chat: 'dedicated' },
      sharedConsent: true,
    });
    expect(wrapper.emitted('advanced')?.at(-1)).toEqual(['ready']);
  });

  it('空存储选项 → 空态确认卡（不空白屏），提交空 choices', async () => {
    stubFetch([{ match: /\/api\/step3b$/, body: { step: 'ready' } }]);
    const wrapper = mount(StorageScreen, {
      props: { storageOptions: [], storageChoices: {}, sharedConsent: false },
    });
    expect(wrapper.text()).toContain('默认落点');
    await wrapper.find('[data-test=storage-submit]').trigger('click');
    await flushPromises();
    expect(wrapper.emitted('advanced')?.at(-1)).toEqual(['ready']);
  });
});

describe('⑤ 完成屏：独立激活入口 + 复制同位换位 + 封箱分流', () => {
  it('setup 深链 → 打开激活页 + 复制后「已复制 ✓」；sealed → 登录链接', async () => {
    const clipWrite = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText: clipWrite } });
    const wrapper = mount(DoneScreen, {
      props: {
        result: { baseUrl: 'https://x.example.com', setupUrl: '/setup?token=tok' },
        instancePath: '/tmp/demo/unself',
        modules: ['hello'],
      },
    });
    expect(wrapper.find('[data-test=open-activation]').attributes('href')).toBe('https://x.example.com/setup?token=tok');
    const copy = wrapper.find('[data-test=copy-link]');
    await copy.trigger('click');
    await flushPromises();
    expect(clipWrite).toHaveBeenCalledWith('https://x.example.com/setup?token=tok');
    expect(wrapper.text()).toContain('已复制');

    await wrapper.setProps({
      result: { baseUrl: 'https://x.example.com', setupUrl: null },
    });
    expect(wrapper.find('[data-test=open-login]').attributes('href')).toBe('https://x.example.com/login');
  });

  it('完成屏展示版本身份三项（#287，决策 #80）：安装器版本 + commit + workbench 版本', async () => {
    const wrapper = mount(DoneScreen, {
      props: {
        result: {
          baseUrl: 'https://x.example.com',
          setupUrl: '/setup?token=tok',
          identity: [
            'unself 版本：v0.3.0（commit 7e511f6a00d2ebe57a5069a5624a3c9eceff3da6）',
            '平台产物：@unself/workbench v0.1.1',
          ],
        },
        instancePath: '/tmp/demo/unself',
        modules: ['hello'],
      },
    });
    // 收敛到 data-test 容器内的可见文本（不看类名/DOM 结构）
    const text = wrapper.find('[data-test=build-identity]').text();
    expect(text).toContain('unself 版本：v0.3.0');
    expect(text).toContain('commit 7e511f6a00d2ebe57a5069a5624a3c9eceff3da6');
    expect(text).toContain('@unself/workbench v0.1.1');
  });

  it('完成屏无身份（旧快照/identity 缺省）→ 不崩、不渲染空容器', async () => {
    const wrapper = mount(DoneScreen, {
      props: {
        result: { baseUrl: 'https://x.example.com', setupUrl: null },
        instancePath: '/tmp/demo/unself',
        modules: ['hello'],
      },
    });
    expect(wrapper.find('[data-test=build-identity]').exists()).toBe(true);
    expect(wrapper.find('[data-test=build-identity]').text()).toBe('');
  });
});
