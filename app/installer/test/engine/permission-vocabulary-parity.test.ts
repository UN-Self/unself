// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 权限词表**同源比对**（issue #294 验收对照）：
 * SDK 对外暴露的 `isKnownPermission` 必须与安装器门禁 `assertKnownPermissions`
 * 逐值一致——否则模块作者用 SDK 自校验「通过」的能力，装机时却被拒（反之亦然）。
 *
 * 两侧都从 `@unself/contracts` 的同一个 `MODULE_PERMISSIONS` 常量派生；本测试
 * 在实际词表 + 典型未知/畸形输入上做**同进程逐值比对**，把「同源」变成可执行断言。
 * 交叉包依赖方向：安装器已依赖 SDK（installer → sdk），故比对放在安装器侧，无环。
 */
import { describe, expect, it } from 'vitest';
import { MODULE_PERMISSIONS as CONTRACT_PERMISSIONS } from '@unself/contracts';
import { isKnownPermission, MODULE_PERMISSIONS as SDK_PERMISSIONS } from '@unself/sdk';

import { assertKnownPermissions } from '../../src/engine/module-sources';

/** 安装器门禁对单个能力名的判定（不抛 = 已知）。 */
function installerKnows(permission: string): boolean {
  try {
    assertKnownPermissions(JSON.stringify({ permissions: [permission] }), true);
    return true;
  } catch {
    return false;
  }
}

/** 覆盖面：实际词表 + 未知词 + 边界/畸形输入。 */
const SAMPLES: unknown[] = [
  ...CONTRACT_PERMISSIONS,
  'telepathy',
  'storage ',
  ' storage',
  'Storage',
  'acl',
  'admin',
  '',
  42,
  null,
];

describe('#294 SDK 权限词表与安装器门禁同源（逐值比对）', () => {
  it('SDK 导出的词表 === 契约词表（同一常量，无第二份）', () => {
    expect([...SDK_PERMISSIONS]).toEqual([...CONTRACT_PERMISSIONS]);
  });

  it('isKnownPermission 与安装器门禁逐值一致', () => {
    for (const sample of SAMPLES) {
      if (typeof sample !== 'string') {
        // 非字符串：SDK 判定未知且不抛；安装器门禁对非数组/畸形输入静默跳过（不构成「已知」）
        expect(isKnownPermission(sample)).toBe(false);
        continue;
      }
      expect(isKnownPermission(sample)).toBe(installerKnows(sample));
    }
  });

  it('storage → 两侧都判已知；telepathy → 两侧都判未知（验收对照项）', () => {
    expect(isKnownPermission('storage')).toBe(true);
    expect(installerKnows('storage')).toBe(true);
    expect(isKnownPermission('telepathy')).toBe(false);
    expect(installerKnows('telepathy')).toBe(false);
  });
});
