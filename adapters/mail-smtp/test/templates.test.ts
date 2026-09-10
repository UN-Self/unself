// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
  renderAccountReady,
  renderInviteResult,
  renderModuleToggled,
} from '../src/templates';

describe('renderInviteResult', () => {
  it('批准：subject/正文含称呼与审批人，并标注通过', () => {
    const mail = renderInviteResult(true, { name: '张三', approver: '管理员老王' });
    expect(mail.subject).toContain('张三');
    expect(mail.subject).toContain('通过');
    expect(mail.text).toContain('张三');
    expect(mail.text).toContain('管理员老王');
    expect(mail.text).toContain('批准');
  });

  it('拒绝：subject 标注未通过，正文不含激活承诺', () => {
    const mail = renderInviteResult(false, { name: '张三', approver: '管理员老王' });
    expect(mail.subject).toContain('未通过');
    expect(mail.text).toContain('未获批准');
    expect(mail.text).not.toContain('批准，账号即日可用');
  });

  it('缺变量给空串，不抛错', () => {
    expect(() => renderInviteResult(true)).not.toThrow();
    const mail = renderInviteResult(true);
    // {name} 缺省渲染为空串，标题退化为「【Unself】 的加入申请已通过」
    expect(mail.subject).toBe('【Unself】 的加入申请已通过');
  });
});

describe('renderAccountReady', () => {
  it('注入邮箱与激活链接', () => {
    const mail = renderAccountReady('alice@example.com', 'https://example.com/activate?t=1');
    expect(mail.text).toContain('alice@example.com');
    expect(mail.text).toContain('https://example.com/activate?t=1');
    expect(mail.subject).toContain('已开通');
  });
});

describe('renderModuleToggled', () => {
  it('启用/停用两种状态区分渲染', () => {
    const on = renderModuleToggled('聊天', true);
    const off = renderModuleToggled('聊天', false);
    expect(on.subject).toContain('已启用');
    expect(off.subject).toContain('已停用');
    expect(on.subject).not.toBe(off.subject);
    expect(on.text).toContain('已启用');
    expect(off.text).toContain('已停用');
  });

  it('模块名注入', () => {
    expect(renderModuleToggled('日历', true).subject).toContain('日历');
  });
});
