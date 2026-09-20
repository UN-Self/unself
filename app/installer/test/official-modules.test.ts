// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 官方模块目录与安装器依赖声明的**一致性守卫**（issue #284，决策 #76/#77）：
 * 「官方 = 默认值，不是特权」的全部依据就是「安装器 dependencies 里精确预装了什么」——
 * 所以默认安装串的版本、workspace 包版本、dependencies 声明三者必须同源，漂移即红。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODULE_IDS,
  OFFICIAL_MODULES,
  defaultModuleEntries,
  isOfficialModule,
  officialModuleEntry,
  officialModuleVersion,
} from '../src/lib/official-modules';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER_DIR = join(HERE, '..');
const REPO_ROOT = join(INSTALLER_DIR, '..', '..');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('#284 官方模块目录', () => {
  it('官方模块只有 hello / chat，默认勾选 hello', () => {
    expect(OFFICIAL_MODULES.map((m) => m.id)).toEqual(['hello', 'chat']);
    expect(OFFICIAL_MODULES.map((m) => m.pkg)).toEqual(['@unself/hello', '@unself/chat']);
    expect([...DEFAULT_MODULE_IDS]).toEqual(['hello']);
    expect(isOfficialModule('hello')).toBe(true);
    expect(isOfficialModule('todo')).toBe(false);
  });

  it('默认安装串是 npm 串（没有 official 特权协议），版本 = 本地已装包版本', () => {
    const entry = officialModuleEntry('hello');
    expect(entry.id).toBe('hello');
    expect(entry.source).toBe(`npm:@unself/hello@${officialModuleVersion('@unself/hello')}`);
    expect(entry.source.startsWith(['official', ':'].join(''))).toBe(false);
    expect(defaultModuleEntries().map((e) => e.id)).toEqual(['hello']);
  });

  it('版本真源一致：dependencies 声明（workspace:*）+ workspace 包版本 + 默认串三者对齐', () => {
    const installerPkg = readJson(join(INSTALLER_DIR, 'package.json')) as {
      dependencies?: Record<string, string>;
    };
    for (const mod of OFFICIAL_MODULES) {
      // ① 安装器 dependencies 必须精确预装（workspace:* = 发布时由 pnpm 改写为版本号）
      expect(installerPkg.dependencies?.[mod.pkg]).toBe('workspace:*');
      // ② workspace 包（pnpm 符号链接 → modules/<id>）的版本就是安装串里的版本
      const pkg = readJson(join(REPO_ROOT, 'app', 'modules', mod.id, 'package.json')) as { name?: string; version?: string };
      expect(pkg.name).toBe(mod.pkg);
      expect(officialModuleVersion(mod.pkg)).toBe(pkg.version);
    }
    // ③ @unself/sdk 也要预装（装配期注入的浏览器侧 SDK 资产取自该包）
    expect(installerPkg.dependencies?.['@unself/sdk']).toBe('workspace:*');
  });

  it('非官方模块 id 不猜包名（宁报错不猜到 @unself/<id>）', () => {
    expect(() => officialModuleEntry('todo')).toThrow(/不是官方模块/);
  });
});
