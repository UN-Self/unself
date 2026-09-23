// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 事件 → UActivity 组投影（纯函数）：九步段解析、按步骤分组、按事件序号 i 去重。
 * - 文本中 `[n/9]` 或 `步骤（n/9）` 定位同一步骤组；无编号事件归入当前组；
 * - 同 i 只渲染一次（快照+增量重叠窗口防重）；
 * - 带编号的完成/失败事件更新组状态；步骤内的成功日志不提前完成整步；
 * - 组标题取首条带编号事件的编号段后文本（如「数据库」），否则「步骤 n/9」。
 */
export interface WizardEventDto {
  i: number
  kind: string
  n?: number
  title?: string
  text: string
}

export interface ActivityLineDto {
  i: number
  text: string
}

export interface ActivityGroupDto {
  step: number
  title: string
  state: 'running' | 'complete' | 'failed'
  lines: ActivityLineDto[]
}

const STEP_RE = /(?:\[(\d)\/9\]|步骤（(\d)\/9）)/;

/** 把（可能含重复的）事件流投影为分组活动（纯函数；不改输入）。 */
export function projectActivity(events: WizardEventDto[]): ActivityGroupDto[] {
  const seen = new Set<number>();
  const groups: ActivityGroupDto[] = [];
  const byStep = new Map<number, ActivityGroupDto>();
  let current: ActivityGroupDto | null = null;

  for (const event of events) {
    if (!event || seen.has(event.i)) continue;
    seen.add(event.i);
    const text = String(event.text ?? '').trim();
    const match = STEP_RE.exec(text);
    if (match || event.n !== undefined) {
      const step = event.n ?? Number(match?.[1] ?? match?.[2]);
      current = byStep.get(step) ?? null;
      if (!current) {
        current = {
          step,
          title: `步骤 ${step}/9`,
          state: 'running',
          lines: [],
        };
        groups.push(current);
        byStep.set(step, current);
        // 同一步只保留一个摘要标题，去除事件尾部的开始/终态标记。
        const rest = event.title ?? (match ? text.slice(match.index + match[0].length) : '');
        if (rest) current.title = `步骤 ${step}/9 ${rest.replace(/[✓✗…\s]+$/, '').trim()}`.trim();
      }
    }
    if (!current) continue;
    current.lines.push({ i: event.i, text: text.trim() });
    // 状态优先级：failed > complete > running（✗ 后续 ✓ 不洗白失败态——组终态语义）
    if (event.kind === 'fail' || text.startsWith('✗') || (match && /✗$/.test(text))) current.state = 'failed';
    else if ((event.kind === 'ok' || (match && /✓$/.test(text))) && current.state !== 'failed') current.state = 'complete';
  }
  return groups;
}

/** 九步进度条状态：n 步已完、第 n+1 步进行中（由活动组推断）。 */
export function progressFromGroups(groups: ActivityGroupDto[]): { done: number; running: number | null; failed: number | null } {
  let done = 0;
  let running: number | null = null;
  let failed: number | null = null;
  for (const g of groups) {
    if (g.state === 'failed') failed = g.step;
    else if (g.state === 'complete') done = Math.max(done, g.step);
    else running = running === null ? g.step : Math.max(running, g.step);
  }
  return { done, running, failed };
}
