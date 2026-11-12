// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 契约对外可见面行为测试（决策 #78② / issue #294）。
 *
 * 站在**模块作者**视角断言「提交前自校验」这条动线：拿到 SDK 就能校验 manifest、
 * 查权限词表、读契约版本。不测实现，只测行为——任一导出被删/被换成恒真对象即红。
 */
import { describe, expect, it } from 'vitest';

import {
  CONTRACT_VERSION,
  MODULE_PERMISSIONS,
  ModuleManifestSchema,
  isKnownPermission,
  manifestFromYamlText,
} from '../src/index';

/** 一份合法 manifest（§3 字段冻结表全字段的最小子集 + 常用可选字段）。 */
const VALID_MANIFEST = {
  id: 'todo',
  version: '1.2.0',
  runtimes: ['worker'],
  route: '/m/todo',
  permissions: ['storage', 'notify'],
  storage: { accepts: ['core', 'self'], preferred: 'core' },
  tables: ['todo_items'],
  compat: { min: '1.0', max: '1.0' },
  description: '待办模块',
  icon: 'list-todo',
};

describe('#294 契约对外可见面：manifest 自校验', () => {
  it('合法 manifest → safeParse 通过，data 保留字段', () => {
    const result = ModuleManifestSchema.safeParse(VALID_MANIFEST);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe('todo');
    expect(result.data.permissions).toEqual(['storage', 'notify']);
  });

  it('parse 入口对合法 manifest 返回同一对象语义', () => {
    const parsed = ModuleManifestSchema.parse(VALID_MANIFEST);
    expect(parsed.id).toBe('todo');
    expect(parsed.storage?.preferred).toBe('core');
  });

  it('【红灯】非法 manifest → safeParse success=false 且 issue 点名出错字段', () => {
    // 多处形状错误：id 大写、version 非三段、runtimes 空、route 不以 /m/ 开头
    const bad = {
      id: 'Todo',
      version: '1.2',
      runtimes: [],
      route: '/todo',
    };
    const result = ModuleManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => String(issue.path[0]));
    expect(paths).toContain('id');
    expect(paths).toContain('route');
    expect(paths).toContain('version');
    expect(paths).toContain('runtimes');
    // 「非法不抛」是模块作者自校验的关键性质：safeParse 永不 throw
    expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it('【#349 U9】清单带 entry → 剥离不报错（地址只由 core 定，真值面 = 注册表 entry 列）', () => {
    const result = ModuleManifestSchema.safeParse({ ...VALID_MANIFEST, entry: 'http://todo.example.com' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).not.toHaveProperty('entry');
  });

  it('【红灯】未知能力 → safeParse 失败（schema 层即拦，不静默丢）', () => {
    const result = ModuleManifestSchema.safeParse({ ...VALID_MANIFEST, permissions: ['storage', 'telepathy'] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => String(issue.path[0]) === 'permissions')).toBe(true);
  });

  it('两值词表：旧值 shared/dedicated/external 全拒；tables 申报但 accepts 不含 core → 拒（护栏②，#349 U5）', () => {
    expect(ModuleManifestSchema.safeParse({ ...VALID_MANIFEST, storage: { accepts: ['shared'] } }).success).toBe(false);
    expect(ModuleManifestSchema.safeParse({ ...VALID_MANIFEST, storage: { accepts: ['external'] } }).success).toBe(false);
    // tableless 的 core（无 tables）合法（hello 形态）；tables + self 矛盾
    expect(ModuleManifestSchema.safeParse({ ...VALID_MANIFEST, storage: { accepts: ['core'] } }).success).toBe(true);
    const bad = ModuleManifestSchema.safeParse({ ...VALID_MANIFEST, storage: { accepts: ['self'] } });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((issue) => String(issue.path[0]) === 'tables')).toBe(true);
    }
  });

  it('coreOrigin 禁止 "*"（决策 #63）→ 拒绝', () => {
    const result = ModuleManifestSchema.safeParse({ ...VALID_MANIFEST, coreOrigin: '*' });
    expect(result.success).toBe(false);
  });
});

describe('#294 manifest.yaml 解析入口', () => {
  it('模块作者把 manifest.yaml 直接喂进 schema → 通过（书写格式与契约同一份解析）', () => {
    const yaml = [
      'id: todo',
      'version: 1.2.0',
      'route: /m/todo',
      'runtimes:',
      '  - worker',
      'permissions:',
      '  - storage',
      'storage:',
      '  accepts:',
      '    - core',
      '  preferred: core',
      'tables:',
      '  - todo_items',
    ].join('\n');
    const candidate = manifestFromYamlText(yaml);
    const result = ModuleManifestSchema.safeParse(candidate);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe('todo');
    expect(result.data.permissions).toEqual(['storage']);
  });

  it('flow 式 list（契约不支持）→ 解析入口直接报错，不静默丢（#64）', () => {
    expect(() => manifestFromYamlText('permissions: [storage, notify]\n')).toThrow(/flow/);
  });
});

describe('#294 权限词表与未知能力判定', () => {
  it('词表非空且含首版 6 项', () => {
    expect(MODULE_PERMISSIONS).toEqual(['storage', 'acl', 'notify', 'ai', 'realtime', 'mail']);
  });

  it('storage → 已知；telepathy → 未知（验收对照项）', () => {
    expect(isKnownPermission('storage')).toBe(true);
    expect(isKnownPermission('telepathy')).toBe(false);
  });

  it('词表全项已知，逐项覆盖', () => {
    for (const permission of MODULE_PERMISSIONS) {
      expect(isKnownPermission(permission)).toBe(true);
    }
  });

  it('大小写敏感：Storage ≠ storage（与安装器门禁口径一致）', () => {
    expect(isKnownPermission('Storage')).toBe(false);
    expect(isKnownPermission('STORAGE')).toBe(false);
  });

  it('非字符串输入 → 未知，不抛（空态/垃圾输入安全）', () => {
    expect(isKnownPermission(undefined)).toBe(false);
    expect(isKnownPermission(null)).toBe(false);
    expect(isKnownPermission(42)).toBe(false);
    expect(isKnownPermission('')).toBe(false);
  });

  it('契约版本可读且为 x.y 形态（模块 compat 比对用）', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+$/);
  });
});
