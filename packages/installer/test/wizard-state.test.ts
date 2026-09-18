// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apexZone,
  beginDeploy,
  buildConfigInput,
  chooseDomain,
  completeDeploy,
  chooseStorage,
  confirmModules,
  failDeploy,
  initialWizardState,
  needsTotalTls,
  pushEvent,
  resetWizard,
  submitToken,
  tokenProblem,
  domainProblem,
  type WizardStorageOption,
} from '../src/web/state';

let instancePath: string;

beforeEach(() => {
  instancePath = join(mkdtempSync(join(tmpdir(), 'unself-wiz-')), 'demo', 'unself');
});

afterEach(() => {
  rmSync(instancePath, { recursive: true, force: true });
});

describe('submitToken（① 密码框语义）', () => {
  it('合法 token → hasToken=true 进 ②；明文不进状态', () => {
    const s = initialWizardState(instancePath);
    const r = submitToken(s, 'A'.repeat(40));
    expect(r.problem).toBeNull();
    expect(r.state.hasToken).toBe(true);
    expect(r.state.step).toBe('domain');
    expect(JSON.stringify(r.state)).not.toContain('A'.repeat(40));
  });

  it('非法 token → 400 人话错误且原地不动', () => {
    const s = initialWizardState(instancePath);
    expect(submitToken(s, '').problem).toMatch(/为空/);
    expect(submitToken(s, `bad ${'A'.repeat(40)}`).problem).toMatch(/空格/);
    expect(submitToken(s, 'not-a-token!').problem).toMatch(/以外的字符/);
    const after = submitToken(s, '').state;
    expect(after.step).toBe('auth');
    expect(after.hasToken).toBe(false);
  });

  it('tokenProblem 只拦形状：#269 放宽——不再要求字母开头/固定长度（CF《Token formats》无此约束）', () => {
    // 老格式：40 位字母数字，首字符可能是数字（约 1/6 概率）
    expect(tokenProblem('1'.repeat(40))).toBeNull();
    // 新格式：cfut_ 前缀 + 40 字符 + 校验和（超 50 位也必须放行）
    expect(tokenProblem(`cfut_${'a'.repeat(40)}${'b'.repeat(8)}`)).toBeNull();
    expect(tokenProblem(`-${'a'.repeat(39)}`)).toBeNull();
    // 短 token 也不再被形状正则拦（真伪交给 CF /user/tokens/verify）
    expect(tokenProblem('x'.repeat(20))).toBeNull();
    expect(tokenProblem('')).toMatch(/为空/);
    expect(tokenProblem('has space')).toMatch(/空格/);
    expect(tokenProblem('bad!char')).toMatch(/以外的字符/);
  });
});

describe('chooseDomain（② 显式三选语义）', () => {
  it('workers.dev 是显式第一选项，domain 走留空语义', () => {
    const s = initialWizardState(instancePath);
    const r = chooseDomain(s, 'workers');
    expect(r.state.step).toBe('modules');
    expect(r.state.domain).toBe('');
    expect(r.state.domainChoice).toBe('workers');
  });

  it('自有域合法 → 进 ③；非法 → 原地不动带人话', () => {
    const s = { ...initialWizardState(instancePath), hasToken: true, step: 'domain' as const };
    const ok = chooseDomain(s, 'custom', 'team.example.com');
    expect(ok.problem).toBeNull();
    expect(ok.state.domain).toBe('team.example.com');

    const bad = chooseDomain(s, 'custom', 'not-a-domain');
    expect(bad.problem).toMatch(/不像完整域名/);
    expect(bad.state.step).toBe('domain');
  });

  it('domainProblem 规则与交互稿一致（空段/连字符位置）', () => {
    expect(domainProblem('a..b')).toMatch(/连续的点/);
    expect(domainProblem('-a.b.com')).toMatch(/连字符不能开头/);
    expect(domainProblem('a-.b.com')).toMatch(/连字符不能开头|结尾/);
    expect(domainProblem('team.example.com')).toBeNull();
  });
});

describe('confirmModules（③ 模块确认）', () => {
  it('去空格去重；空清单/非法 id 人话拒绝', () => {
    const s = { ...initialWizardState(instancePath), hasToken: true, step: 'modules' as const };
    const r = confirmModules(s, [' hello ', 'chat', 'hello', '']);
    expect(r.problem).toBeNull();
    expect(r.state.modules).toEqual(['hello', 'chat']);
    // #248：③ 模块确认后先进存储选择（③½ storage），④ ready 在 chooseStorage 之后
    expect(r.state.step).toBe('storage');

    expect(confirmModules(s, []).problem).toMatch(/至少确认一个/);
    expect(confirmModules(s, ['Bad_ID']).problem).toMatch(/不合法/);
  });
});

describe('buildConfigInput（workers.dev 语义 = domain 空串）', () => {
  it('workers 选项 → domain 空串；自有域 → 原文', () => {
    const workers = chooseDomain(initialWizardState(instancePath), 'workers').state;
    expect(buildConfigInput(workers).domain).toBe('');

    const custom = chooseDomain(initialWizardState(instancePath), 'custom', 't.example.com').state;
    expect(buildConfigInput(custom).domain).toBe('t.example.com');
    expect(buildConfigInput(custom).storage).toEqual({ provider: 'r2', bucket: 'unself-storage' });
  });
});

describe('④ 进度事件 + ⑤ 收尾 + ⑥ 幂等重跑', () => {
  it('pushEvent 自增编号；begin/complete/fail 状态翻转', () => {
    let s = initialWizardState(instancePath);
    s = beginDeploy(s);
    pushEvent(s, { kind: 'log', text: '第一步' });
    pushEvent(s, { kind: 'log', text: '第二步' });
    expect(s.events.map((e) => e.i)).toEqual([0, 1]);

    const done = completeDeploy(s, { baseUrl: 'https://x.workers.dev', setupUrl: '/setup?token=t' });
    expect(done.step).toBe('done');
    expect(done.result?.baseUrl).toBe('https://x.workers.dev');

    const failed = failDeploy(s, { cause: ' boom ', owner: 'code', fix: '重跑' });
    expect(failed.step).toBe('failed');
    expect(failed.error?.owner).toBe('code');
  });

  it('失败三要素落状态：cause/owner/fix 都在（fix 必非空）', () => {
    const s = failDeploy(initialWizardState(instancePath), {
      cause: '10405',
      owner: 'token',
      fix: '重建 token',
    });
    expect(s.error).toEqual({ cause: '10405', owner: 'token', fix: '重建 token' });
    expect(s.error?.fix.length).toBeGreaterThan(0);
  });

  it('⑥ reset：清事件/错误/结果回 ①，实例路径与模块选择保留', () => {
    let s = initialWizardState(instancePath, { modules: ['chat'] });
    s = beginDeploy(s);
    pushEvent(s, { kind: 'log', text: 'x' });
    s = failDeploy(s, { cause: 'x', owner: 'code', fix: 'y' });

    const r = resetWizard(s);
    expect(r.step).toBe('auth');
    expect(r.events).toEqual([]);
    expect(r.error).toBeNull();
    expect(r.result).toBeNull();
    expect(r.instancePath).toBe(instancePath);
    expect(r.modules).toEqual(['chat']);
  });
});

describe('needsTotalTls / apexZone（#246 决策 #66 内联判定，语义同 steps.needsTotalTls）', () => {
  it('多级子域（超过 zone 一层）→ true；单级 → false', () => {
    expect(needsTotalTls('a.team.example.com', 'example.com')).toBe(true);
    expect(needsTotalTls('deep.a.team.example.com', 'example.com')).toBe(true);
    expect(needsTotalTls('team.example.com', 'example.com')).toBe(false);
    expect(needsTotalTls('example.com', 'example.com')).toBe(false);
  });

  it('apexZone 取末两段；多段输入与空段容错', () => {
    expect(apexZone('a.team.example.com')).toBe('example.com');
    expect(apexZone('team.example.com')).toBe('example.com');
    expect(apexZone('example.com')).toBe('example.com');
    expect(apexZone('a..team.example.com')).toBe('example.com');
  });

  it('组合语义：向导①折叠入口露出条件（多级子域 → 需 API Token/Total TLS）', () => {
    const domain = 'a.team.example.com';
    expect(needsTotalTls(domain, apexZone(domain))).toBe(true);
  });
});

describe('chooseStorage（③½ 存储选择，#55）', () => {
  const OPTS: WizardStorageOption[] = [
    { id: 'hello', accepts: ['core'] },
    { id: 'demo', accepts: ['core', 'shared'], preferred: 'core' },
  ];

  function stateWith(): ReturnType<typeof initialWizardState> {
    const s = { ...initialWizardState(instancePath, { storageOptions: OPTS.map((o) => ({ ...o })) }), hasToken: true, step: 'storage' as const };
    return s;
  }

  it('默认选择 = preferred ?? core；合法选择进 ready', () => {
    const r = chooseStorage(stateWith(), {}, false);
    expect(r.problem).toBeNull();
    expect(r.state.step).toBe('ready');
    expect(r.state.storageChoices).toEqual({ hello: 'core', demo: 'core' });
  });

  it('选了 accepts 之外的模式 → 拒绝（不进 ④）', () => {
    const r = chooseStorage(stateWith(), { hello: 'shared' }, true);
    expect(r.problem).toMatch(/不支持.*shared.*accepts 之外/);
    expect(r.state.step).toBe('storage');
    const r2 = chooseStorage(stateWith(), { demo: 'dedicated' }, false);
    expect(r2.problem).toMatch(/不支持.*dedicated/);
  });

  it('shared 需知情同意：未勾选拒绝；勾选后通过且 consent 落状态', () => {
    const no = chooseStorage(stateWith(), { demo: 'shared' }, false);
    expect(no.problem).toMatch(/知情同意/);
    const yes = chooseStorage(stateWith(), { demo: 'shared' }, true);
    expect(yes.problem).toBeNull();
    expect(yes.state.storageChoices.demo).toBe('shared');
    expect(yes.state.sharedConsent).toBe(true);
  });
});
