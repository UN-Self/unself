// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { ACTIONS, ROLES, decide, may, resolveRole, type Action, type Role } from '../src/auth/policy';

/**
 * 权限矩阵是「越权只能靠 API 侧裁决」这条纪律的唯一落点（#358 §10 风险三条）。
 * 逐格断言，不留「反正 owner 能过」的推断空隙。
 */
describe('角色 × 动作矩阵', () => {
  const matrix: Record<Role, Record<Action, boolean>> = {
    owner: { read: true, write: true, delete: true },
    editor: { read: true, write: true, delete: false },
    viewer: { read: true, write: false, delete: false },
  };

  for (const role of ROLES) {
    for (const action of ACTIONS) {
      it(`${role} × ${action} → ${matrix[role][action] ? '放行' : '拒绝'}`, () => {
        expect(may(role, action)).toBe(matrix[role][action]);
      });
    }
  }

  it('非成员（null）任何动作都不放行', () => {
    for (const action of ACTIONS) expect(may(null, action)).toBe(false);
  });
});

describe('裁决顺序：404 先于 403', () => {
  it('非成员 → 404（不是 403，存在性不外泄）', () => {
    expect(decide(null, 'read')).toEqual({ allow: false, status: 404 });
    expect(decide(null, 'write')).toEqual({ allow: false, status: 404 });
    expect(decide(null, 'delete')).toEqual({ allow: false, status: 404 });
  });

  it('是成员但角色不够 → 403', () => {
    expect(decide('viewer', 'write')).toEqual({ allow: false, status: 403 });
    expect(decide('viewer', 'delete')).toEqual({ allow: false, status: 403 });
    expect(decide('editor', 'delete')).toEqual({ allow: false, status: 403 });
  });

  it('够格 → 放行', () => {
    expect(decide('owner', 'delete')).toEqual({ allow: true });
    expect(decide('editor', 'write')).toEqual({ allow: true });
    expect(decide('viewer', 'read')).toEqual({ allow: true });
  });
});

describe('resolveRole：owner 优先，成员表只认两值', () => {
  it('owner_id 命中即 owner，哪怕成员表里残留 viewer 行', () => {
    expect(resolveRole({ ownerId: 'u1', userId: 'u1', memberRole: 'viewer' })).toBe('owner');
  });

  it('非 owner 按成员表取值', () => {
    expect(resolveRole({ ownerId: 'u1', userId: 'u2', memberRole: 'editor' })).toBe('editor');
    expect(resolveRole({ ownerId: 'u1', userId: 'u2', memberRole: 'viewer' })).toBe('viewer');
  });

  it('成员表脏值 / 缺行一律当非成员（fail-closed，不猜）', () => {
    expect(resolveRole({ ownerId: 'u1', userId: 'u2', memberRole: 'admin' })).toBeNull();
    expect(resolveRole({ ownerId: 'u1', userId: 'u2', memberRole: '' })).toBeNull();
    expect(resolveRole({ ownerId: 'u1', userId: 'u2', memberRole: null })).toBeNull();
    expect(resolveRole({ ownerId: 'u1', userId: 'u2' })).toBeNull();
  });

  it('owner 判定用 id 相等，不做字符串归一（id 由 core 签发，不做业务加工）', () => {
    expect(resolveRole({ ownerId: 'user-1', userId: 'USER-1', memberRole: 'editor' })).toBe('editor');
  });
});
