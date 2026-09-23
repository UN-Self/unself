// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { progressTracker } from '../src/engine/progress';
import { projectActivity, progressFromGroups, type WizardEventDto } from '../web/src/lib/activity-projection';

function capture() {
  const events: WizardEventDto[] = [];
  const tracker = progressTracker({ total: 9, out: text => events.push({ i: events.length, kind: 'log', text }) });
  return { events, tracker };
}

describe('真实九步事件投影', () => {
  it('开始与完成更新同组；重复快照不增加组或行；完成后没有残留 running', () => {
    const { events, tracker } = capture();
    for (let n = 1; n <= 9; n++) {
      tracker.reporter.step(n, `任务 ${n}`);
      tracker.reporter.log('资源就绪');
    }
    tracker.complete();
    const groups = projectActivity([...events, ...events]);
    expect(groups).toHaveLength(9);
    expect(groups.every(g => g.state === 'complete')).toBe(true);
    expect(groups.map(g => g.lines.length)).toEqual(Array(9).fill(3));
    expect(progressFromGroups(groups)).toEqual({ done: 9, running: null, failed: null });
  });

  it('步骤内部成功日志不提前完成；行尾失败符号标记同一步失败', () => {
    const { events, tracker } = capture();
    tracker.reporter.step(1, '数据库');
    tracker.reporter.log('✓ 其中一项完成');
    expect(projectActivity(events)[0]?.state).toBe('running');
    tracker.fail(new Error('probe failed'));
    const groups = projectActivity(events);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.state).toBe('failed');
    expect(progressFromGroups(groups)).toEqual({ done: 0, running: null, failed: 1 });
  });
});
