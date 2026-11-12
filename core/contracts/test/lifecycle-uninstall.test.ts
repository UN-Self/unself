// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 卸载策略契约（#270 定案 + #349 U5 两值收敛）测试：
 * 平台按 storage 落点 + manifest.tables 清单清理；self（自托管）平台不碰数据、无表可删；
 * core（自建表）取清单；未申报 tables → 空清单（宁可不删，绝不按前缀猜表名误删）。
 * 两值映射：原 dedicated/shared/旧 core（经代理）→ core；external → self；缺省 = self。
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

  it('core 落点取 manifest.tables 清单（分表隔离，#349 U5）', () => {
    const plan = platformUninstallPlan({
      id: 'chat',
      storage: { declaration: 'core' },
      tables: ['users', 'channels'],
    });
    expect(plan).toEqual({ moduleId: 'chat', level: 'core', tables: ['users', 'channels'] });
  });

  it('core 落点但未申报 tables → 空清单（不猜）', () => {
    expect(platformUninstallPlan({ id: 'c', storage: { declaration: 'core' } }).tables).toEqual([]);
  });

  it('self 落点无表可删；缺省（无 storage 声明）= self', () => {
    expect(platformUninstallPlan({ id: 'hello' })).toEqual({ moduleId: 'hello', level: 'self', tables: [] });
    expect(platformUninstallPlan({ id: 'b', storage: { declaration: 'self' }, tables: ['b_x'] }).tables).toEqual([]);
  });

  it('declaration 优先于 preferred；两值之外一律回落 self', () => {
    expect(
      effectiveStorageLevel({ storage: { declaration: 'self', preferred: 'core' } }),
    ).toBe('self');
    expect(effectiveStorageLevel({ storage: { preferred: 'core' } })).toBe('core');
    expect(effectiveStorageLevel({ storage: { declaration: 'dedicated' } })).toBe('self');
    expect(effectiveStorageLevel({ storage: { declaration: 'shared' } })).toBe('self');
    expect(effectiveStorageLevel({})).toBe('self');
  });
});
