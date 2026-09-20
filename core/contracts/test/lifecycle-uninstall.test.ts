// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 卸载策略契约（#270 定案）测试：
 * 平台按 storage 落点 + manifest.tables 清单清理；core/external 无表可删；
 * 未申报 tables 的自建表落点 → 空清单（宁可不删，绝不按前缀猜表名误删）。
 */
import { describe, expect, it } from 'vitest';

import {
  effectiveStorageLevel,
  MODULE_UNINSTALL_STRATEGY,
  platformUninstallPlan,
} from '../src/lifecycle';

describe('#270 卸载策略定案', () => {
  it('当前策略 = 平台按 tables 清单清理（无模块内钩子）', () => {
    expect(MODULE_UNINSTALL_STRATEGY).toBe('platform-tables-cleanup');
  });

  it('shared 落点取 manifest.tables 清单', () => {
    const plan = platformUninstallPlan({
      id: 'todo',
      storage: { declaration: 'shared' },
      tables: ['todo_items', 'todo_lists'],
    });
    expect(plan).toEqual({ moduleId: 'todo', level: 'shared', tables: ['todo_items', 'todo_lists'] });
  });

  it('dedicated 落点取清单（表名无需模块前缀，chat 形态）', () => {
    const plan = platformUninstallPlan({
      id: 'chat',
      storage: { preferred: 'dedicated' },
      tables: ['users', 'channels'],
    });
    expect(plan.level).toBe('dedicated');
    expect(plan.tables).toEqual(['users', 'channels']);
  });

  it('core / external 落点无表可删', () => {
    expect(platformUninstallPlan({ id: 'hello' }).tables).toEqual([]);
    expect(platformUninstallPlan({ id: 'a', storage: { declaration: 'core' }, tables: ['a_x'] }).tables).toEqual([]);
    expect(platformUninstallPlan({ id: 'b', storage: { declaration: 'external' }, tables: ['b_x'] }).tables).toEqual([]);
  });

  it('自建表落点但未申报 tables → 空清单（不猜）', () => {
    expect(platformUninstallPlan({ id: 'c', storage: { declaration: 'shared' } }).tables).toEqual([]);
  });

  it('declaration 优先于 preferred', () => {
    expect(
      effectiveStorageLevel({ storage: { declaration: 'shared', preferred: 'dedicated' } }),
    ).toBe('shared');
    expect(effectiveStorageLevel({ storage: { preferred: 'dedicated' } })).toBe('dedicated');
    expect(effectiveStorageLevel({})).toBe('core');
  });
});
